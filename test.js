/**
 * Self-check for the pure parsing logic. Run with: node test.js
 *
 * The `vscode` module only exists inside the extension host, so it is stubbed
 * into the require cache before extension.js is loaded.
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

const stub = {
    SymbolKind: { Class: 4, Interface: 10, Enum: 9, Struct: 22, Object: 18 },
    CompletionItemKind: { Class: 6 },
    CompletionItem: class {},
    MarkdownString: class {},
    Range: class {},
    window: { createOutputChannel: () => ({}) },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    languages: {},
    commands: {},
};

const stubPath = path.join(__dirname, 'vscode-stub.js');
const stubModule = new Module(stubPath);
stubModule.exports = stub;
stubModule.loaded = true;
require.cache[stubPath] = stubModule;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? stubPath : originalResolve.call(this, request, ...rest);
};

const {
    collectImports,
    importStatements,
    isNameUsed,
    unusedImports,
    maskLiterals,
    relativize,
    fullyQualifiedName,
    shortName,
    psr4NamespaceFor,
    namespaceDeclaration,
    offsetToPosition,
    typeDeclaration,
    fqnReplacements,
    bareNameReplacements,
    resolvesBareName,
    fileBaseName,
} = require('./extension.js');

const source = `<?php

namespace App\\Filament\\Resources;

use Filament\\Forms;
use Filament\\Tables\\Table;
use Filament\\Schemas\\Components\\Section as Panel;
use Illuminate\\Support\\{Str, Collection};
use function Filament\\Support\\format_money;
use const App\\SOME_FLAG;

class PostResource
{
    use HasFactory;

    public function boot(): void
    {
        $handler = function () use ($container) {
            return $container;
        };
    }
}
`;

const imports = collectImports(source);
const aliasOf = (alias) => imports.find((entry) => entry.alias === alias);

assert.deepStrictEqual(aliasOf('Forms'), { fqn: 'Filament\\Forms', alias: 'Forms' }, 'plain import');
assert.deepStrictEqual(aliasOf('Table'), { fqn: 'Filament\\Tables\\Table', alias: 'Table' }, 'nested import');
assert.deepStrictEqual(
    aliasOf('Panel'),
    { fqn: 'Filament\\Schemas\\Components\\Section', alias: 'Panel' },
    'aliased import',
);
assert.deepStrictEqual(aliasOf('Str'), { fqn: 'Illuminate\\Support\\Str', alias: 'Str' }, 'group import member');
assert.deepStrictEqual(
    aliasOf('Collection'),
    { fqn: 'Illuminate\\Support\\Collection', alias: 'Collection' },
    'second group import member',
);
assert.strictEqual(
    imports.length,
    5,
    'function/const imports, the trait use and the closure use are all excluded',
);
assert.strictEqual(aliasOf('HasFactory'), undefined, 'a trait use inside a class body is not an import');
assert.strictEqual(aliasOf('$container'), undefined, 'a closure use is not an import');

// Both legal placements the line-anchored regex used to miss.
const inline = collectImports('<?php use Filament\\Forms; use Illuminate\\Support\\Str;');
assert.deepStrictEqual(
    inline.map((entry) => entry.fqn),
    ['Filament\\Forms', 'Illuminate\\Support\\Str'],
    'parses an opening tag import and multiple imports on one line',
);

// The behaviour the extension exists for.
assert.strictEqual(
    relativize('Filament\\Forms\\Components\\TextInput', imports),
    'Forms\\Components\\TextInput',
    'rewrites against an imported namespace prefix',
);

// An alias must be honoured rather than the original trailing segment.
assert.strictEqual(
    relativize('Filament\\Schemas\\Components\\Section\\Nested', imports),
    'Panel\\Nested',
    'rewrites against the alias',
);

// Already imported directly: the short name already works, offering a longer
// form would be strictly worse.
assert.strictEqual(relativize('Filament\\Tables\\Table', imports), null, 'skips a direct import');

// Nothing imported covers this namespace.
assert.strictEqual(relativize('Spatie\\MediaLibrary\\HasMedia', imports), null, 'skips an uncovered namespace');

// A prefix must end on a namespace separator, never mid-segment.
assert.strictEqual(
    relativize('Filament\\FormsExtra\\Widget', imports),
    null,
    'does not match a partial segment',
);

// Longest matching prefix wins, otherwise `use A;` would shadow `use A\\B;`.
const nested = collectImports('<?php use Filament\\Forms; use Filament\\Forms\\Components;');
assert.strictEqual(
    relativize('Filament\\Forms\\Components\\TextInput', nested),
    'Components\\TextInput',
    'prefers the longest matching import',
);

assert.strictEqual(
    fullyQualifiedName({ name: 'TextInput', containerName: 'Filament\\Forms\\Components' }),
    'Filament\\Forms\\Components\\TextInput',
    'joins container and name',
);
assert.strictEqual(
    fullyQualifiedName({ name: 'TextInput', containerName: '' }),
    'TextInput',
    'tolerates a missing container',
);

// --- shapes observed from DEVSENSE PHP Tools -------------------------------
// Classes arrive fully qualified in `name` with an empty container.
assert.strictEqual(
    fullyQualifiedName({ name: 'Filament\\Forms\\Components\\TextInput', containerName: '' }),
    'Filament\\Forms\\Components\\TextInput',
    'a name that is already fully qualified is left alone',
);

// Constants and methods repeat the namespace in both fields; joining them
// would produce App\Enums\Icons\Lucide\App\Enums\Icons\Lucide::TextCursorInput.
assert.strictEqual(
    fullyQualifiedName({
        name: 'App\\Enums\\Icons\\Lucide::TextCursorInput',
        containerName: 'App\\Enums\\Icons\\Lucide',
    }),
    'App\\Enums\\Icons\\Lucide::TextCursorInput',
    'does not duplicate a namespace repeated in both fields',
);

// The real end-to-end case, using the imports of an actual project file.
const liveImports = collectImports(`<?php
use App\\Traits\\CanUploadFiles;
use Filament\\Forms;
use Filament\\Forms\\Components\\Builder\\Block;
use Filament\\Schemas;
use Afsakar\\FilamentFabricator\\PageBlocks\\PageBlock;
`);

assert.strictEqual(
    relativize(
        fullyQualifiedName({ name: 'Filament\\Forms\\Components\\TextInput', containerName: '' }),
        liveImports,
    ),
    'Forms\\Components\\TextInput',
    'end to end: a real symbol against a real import block',
);

assert.strictEqual(
    relativize(
        fullyQualifiedName({ name: 'Filament\\Schemas\\Components\\Section', containerName: '' }),
        liveImports,
    ),
    'Schemas\\Components\\Section',
    'end to end: a second imported namespace',
);

// Nothing in that file imports the PHPUnit tree, so the fuzzy noise the symbol
// provider returns must not produce a suggestion.
assert.strictEqual(
    relativize('PHPUnit\\TextUI\\XmlConfiguration\\PHPUnit', liveImports),
    null,
    'end to end: unrelated fuzzy matches are dropped',
);

// --- PSR-4 namespace resolution -------------------------------------------
// Taken verbatim from a real Laravel composer.json, including autoload-dev.
const psr4 = {
    'App\\': 'app/',
    'Database\\Factories\\': 'database/factories/',
    'Database\\Seeders\\': 'database/seeders/',
    'Tests\\': 'tests/',
    'Afsakar\\FilamentFabricator\\Tests\\': 'plugins/filament-fabricator/tests/',
};

const namespaceOf = (path) => psr4NamespaceFor(path, psr4);

assert.strictEqual(namespaceOf('app/Models/User.php'), 'App\\Models', 'nested file');
assert.strictEqual(namespaceOf('app/User.php'), 'App', 'file directly in the mapped root');
assert.strictEqual(
    namespaceOf('app/Filament/PageBlocks/Home/Hero.php'),
    'App\\Filament\\PageBlocks\\Home',
    'deeply nested file',
);
assert.strictEqual(
    namespaceOf('database/seeders/Cms/PageSeeder.php'),
    'Database\\Seeders\\Cms',
    'a second mapped root',
);
assert.strictEqual(
    namespaceOf('plugins/filament-fabricator/tests/Unit/BlockTest.php'),
    'Afsakar\\FilamentFabricator\\Tests\\Unit',
    'a package root nested inside the project',
);
assert.strictEqual(namespaceOf('resources/views/welcome.blade.php'), null, 'an unmapped path');

// A directory whose name merely starts with a mapped root is not inside it.
assert.strictEqual(namespaceOf('application/Models/User.php'), null, 'no partial directory match');

// The more specific mapping must win, otherwise moving a file into a
// sub-package would produce a namespace that does not autoload.
const overlapping = { 'App\\': 'app/', 'App\\Domain\\': 'app/Domain/' };
assert.strictEqual(
    psr4NamespaceFor('app/Domain/Billing/Invoice.php', overlapping),
    'App\\Domain\\Billing',
    'prefers the longest matching root',
);

// PSR-4 permits an array of roots for one prefix.
assert.strictEqual(
    psr4NamespaceFor('src/Support/Str.php', { 'App\\': ['app/', 'src/'] }),
    'App\\Support',
    'handles an array of roots',
);

// Trailing slashes and a leading `./` are both legal in composer.json.
assert.strictEqual(
    psr4NamespaceFor('app/Models/User.php', { 'App\\': './app' }),
    'App\\Models',
    'normalises the root spelling',
);

assert.strictEqual(psr4NamespaceFor('app/Models/User.php', {}), null, 'empty map');
assert.strictEqual(psr4NamespaceFor('app/Models/User.php', undefined), null, 'missing map');

assert.strictEqual(shortName('Filament\\Forms\\Components\\TextInput'), 'TextInput', 'trailing segment');
assert.strictEqual(shortName('TextInput'), 'TextInput', 'an unqualified name is its own short name');

// --- namespace declaration -------------------------------------------------
const declarationIn = (text) => namespaceDeclaration(text);

const simple = declarationIn('<?php\n\nnamespace App\\Models;\n\nclass User {}\n');
assert.strictEqual(simple.name, 'App\\Models', 'reads the declared namespace');
assert.strictEqual(
    '<?php\n\nnamespace App\\Models;\n\nclass User {}\n'.slice(simple.index, simple.index + simple.name.length),
    'App\\Models',
    'the reported offset points at the name',
);

// `indexOf` on the whole match would find this name inside the keyword itself.
const awkward = declarationIn('<?php\nnamespace space;\n');
assert.strictEqual(awkward.name, 'space', 'reads a namespace named after part of the keyword');
assert.strictEqual(
    '<?php\nnamespace space;\n'.slice(awkward.index, awkward.index + awkward.name.length),
    'space',
    'the offset skips the keyword',
);

const braced = declarationIn('<?php\nnamespace App\\Support {\n}\n');
assert.strictEqual(braced.name, 'App\\Support', 'handles the braced form');

assert.strictEqual(declarationIn('<?php\n\nreturn [];\n'), null, 'a file with no namespace');

// --- offset to position ----------------------------------------------------
const positioned = '<?php\n\nnamespace App\\Models;\n';
const at = namespaceDeclaration(positioned);

assert.deepStrictEqual(offsetToPosition(positioned, 0), { line: 0, character: 0 }, 'start of file');
assert.deepStrictEqual(
    offsetToPosition(positioned, at.index),
    { line: 2, character: 10 },
    'the namespace name sits after the keyword on the third line',
);
assert.deepStrictEqual(
    offsetToPosition(positioned, at.index + at.name.length),
    { line: 2, character: 20 },
    'the end of the namespace name',
);

// The declaration must survive a CRLF file, since the offset is counted in the
// same units VS Code uses for a character index.
const crlf = '<?php\r\n\r\nnamespace App\\Models;\r\n';
const crlfDeclaration = namespaceDeclaration(crlf);
assert.strictEqual(crlfDeclaration.name, 'App\\Models', 'reads a CRLF file');
assert.deepStrictEqual(
    offsetToPosition(crlf, crlfDeclaration.index),
    { line: 2, character: 10 },
    'CRLF line endings do not shift the character index',
);

// --- type declaration ------------------------------------------------------
assert.strictEqual(typeDeclaration('<?php\nclass User {}\n'), 'User', 'plain class');
assert.strictEqual(typeDeclaration('<?php\nfinal class User {}\n'), 'User', 'final class');
assert.strictEqual(typeDeclaration('<?php\nabstract class Base {}\n'), 'Base', 'abstract class');
assert.strictEqual(typeDeclaration('<?php\nenum Status: string {}\n'), 'Status', 'backed enum');
assert.strictEqual(typeDeclaration('<?php\ninterface Contract {}\n'), 'Contract', 'interface');
assert.strictEqual(typeDeclaration('<?php\ntrait HasSlug {}\n'), 'HasSlug', 'trait');
assert.strictEqual(typeDeclaration('<?php\nreturn [];\n'), null, 'no type');

// --- fully qualified name replacement --------------------------------------
const OLD = 'App\\Models\\User';
const NEW = 'App\\Domain\\User';

const rewrite = (text) => {
    let result = text;
    for (const edit of fqnReplacements(text, OLD, NEW).reverse()) {
        result = result.slice(0, edit.index) + edit.replacement + result.slice(edit.index + edit.length);
    }
    return result;
};

assert.strictEqual(rewrite('use App\\Models\\User;'), 'use App\\Domain\\User;', 'a use statement');
assert.strictEqual(
    rewrite('use App\\Models\\User as Account;'),
    'use App\\Domain\\User as Account;',
    'an aliased use statement',
);
assert.strictEqual(rewrite('\\App\\Models\\User::class'), '\\App\\Domain\\User::class', 'root qualified');
assert.strictEqual(rewrite("'App\\Models\\User'"), "'App\\Domain\\User'", 'a single quoted string');
assert.strictEqual(
    rewrite('"App\\\\Models\\\\User"'),
    '"App\\\\Domain\\\\User"',
    'a double quoted string, where PHP requires doubled separators',
);
assert.strictEqual(
    rewrite('use App\\Models\\User;\nuse App\\Models\\Post;'),
    'use App\\Domain\\User;\nuse App\\Models\\Post;',
    'leaves a sibling class alone',
);

// The four boundary cases the guards exist for.
assert.strictEqual(rewrite('use App\\Models\\Users;'), 'use App\\Models\\Users;', 'a longer class name');
assert.strictEqual(
    rewrite('use Vendor\\App\\Models\\User;'),
    'use Vendor\\App\\Models\\User;',
    'the same tail under a different vendor namespace',
);
assert.strictEqual(
    rewrite('use App\\Models\\User\\Profile;'),
    'use App\\Models\\User\\Profile;',
    'a deeper class that merely starts with the moved one',
);
assert.strictEqual(rewrite('$user = new User();'), '$user = new User();', 'the bare short name is untouched');

// A doubled-separator occurrence must not also be counted as a single one.
assert.strictEqual(fqnReplacements('"App\\\\Models\\\\User"', OLD, NEW).length, 1, 'no double counting');
assert.strictEqual(fqnReplacements('use App\\Models\\User;', OLD, NEW).length, 1, 'one edit per occurrence');

// --- file base name --------------------------------------------------------
assert.strictEqual(fileBaseName('/app/Models/User.php'), 'User', 'strips the extension');
assert.strictEqual(fileBaseName('/app/Models/User'), 'User', 'tolerates a missing extension');

// --- bare class name replacement -------------------------------------------
const bare = (text) => {
    let result = text;
    for (const edit of bareNameReplacements(text, 'RichTextBlock', 'RichEditorBlock').reverse()) {
        result = result.slice(0, edit.index) + edit.replacement + result.slice(edit.index + edit.length);
    }
    return result;
};

assert.strictEqual(bare('RichTextBlock::make()'), 'RichEditorBlock::make()', 'a static call');
assert.strictEqual(bare('new RichTextBlock()'), 'new RichEditorBlock()', 'instantiation');
assert.strictEqual(bare('class RichTextBlock extends Base'), 'class RichEditorBlock extends Base', 'the declaration');
assert.strictEqual(bare('RichTextBlock::class'), 'RichEditorBlock::class', 'a class constant');
assert.strictEqual(bare('function f(RichTextBlock $b)'), 'function f(RichEditorBlock $b)', 'a type hint');

// Each of these is something else that merely reads the same.
assert.strictEqual(bare('$RichTextBlock = 1;'), '$RichTextBlock = 1;', 'a variable');
assert.strictEqual(bare('$this->RichTextBlock'), '$this->RichTextBlock', 'a property');
assert.strictEqual(bare('Other\\RichTextBlock::make()'), 'Other\\RichTextBlock::make()', 'a qualified name');
assert.strictEqual(bare("'RichTextBlock'"), "'RichTextBlock'", 'a quoted key');
assert.strictEqual(bare('"RichTextBlock"'), '"RichTextBlock"', 'a double quoted key');
assert.strictEqual(bare('RichTextBlockLegacy::make()'), 'RichTextBlockLegacy::make()', 'a longer identifier');
assert.strictEqual(bare('Config::RichTextBlock'), 'Config::RichTextBlock', 'a class constant of something else');

// --- which files resolve a bare name ---------------------------------------
const RENAME = { oldFqn: 'App\\Blocks\\RichTextBlock', oldName: 'RichTextBlock' };

assert.strictEqual(
    resolvesBareName('<?php\nnamespace App\\Pages;\nuse App\\Blocks\\RichTextBlock;\n', RENAME),
    true,
    'an unaliased import resolves the bare name',
);
assert.strictEqual(
    resolvesBareName('<?php\nnamespace App\\Blocks;\n', RENAME),
    true,
    'the same namespace resolves the bare name without any import',
);
assert.strictEqual(
    resolvesBareName('<?php\nnamespace App\\Pages;\nuse App\\Blocks\\RichTextBlock as Legacy;\n', RENAME),
    false,
    'an aliased import leaves the body referring to the alias',
);
assert.strictEqual(
    resolvesBareName('<?php\nnamespace App\\Pages;\nuse App\\Other\\RichTextBlock;\n', RENAME),
    false,
    'a same-named class from elsewhere is not the renamed one',
);

// --- partially qualified names ---------------------------------------------
// The spelling this extension's own completion produces, and the one a real
// project turned out to use: `use App\\Filament\\PageBlocks;` followed by
// `PageBlocks\\About\\CompanyInfoBlock::toBlock()`.
const seeder = `<?php
namespace Database\\Seeders\\Cms;

use App\\Filament\\PageBlocks;

class PageSeeder
{
    public function run(): void
    {
        Page::create(['blocks' => [
            PageBlocks\\About\\CompanyInfoBlock::toBlock(),
            PageBlocks\\Breadcrumb\\DefaultBlock::toBlock(),
        ]]);
    }
}
`;

const seederImports = collectImports(seeder);
const MOVED_OLD = 'App\\Filament\\PageBlocks\\About\\CompanyInfoBlock';
const MOVED_NEW = 'App\\Filament\\PageBlocks\\CompanyInfoBlock';

assert.strictEqual(
    relativize(MOVED_OLD, seederImports),
    'PageBlocks\\About\\CompanyInfoBlock',
    'the old name as the file spells it',
);
assert.strictEqual(
    relativize(MOVED_NEW, seederImports),
    'PageBlocks\\CompanyInfoBlock',
    'the new name still sits under the same import',
);

const relativeEdits = fqnReplacements(
    seeder,
    relativize(MOVED_OLD, seederImports),
    relativize(MOVED_NEW, seederImports),
    { separators: ['\\'], rootQualified: false },
);
assert.strictEqual(relativeEdits.length, 1, 'one partially qualified occurrence');
assert.strictEqual(
    seeder.slice(0, relativeEdits[0].index) +
        relativeEdits[0].replacement +
        seeder.slice(relativeEdits[0].index + relativeEdits[0].length),
    seeder.replace('PageBlocks\\About\\CompanyInfoBlock', 'PageBlocks\\CompanyInfoBlock'),
    'the sibling block on the next line is untouched',
);

// The short name is the pre-filter needle precisely because this file contains
// neither the full name nor the old namespace anywhere.
assert.ok(!seeder.includes(MOVED_OLD), 'the file never spells the name in full');
assert.ok(!seeder.includes('App\\Filament\\PageBlocks\\About'), 'nor the old namespace');
assert.ok(seeder.includes('CompanyInfoBlock'), 'but it must contain the short name');

// A relative name must not match when root-qualified: `\PageBlocks\...` names
// something in the root namespace, not the imported one.
assert.strictEqual(
    fqnReplacements('\\PageBlocks\\About\\CompanyInfoBlock::x()', 'PageBlocks\\About\\CompanyInfoBlock', 'Z', {
        separators: ['\\'],
        rootQualified: false,
    }).length,
    0,
    'a root-qualified name is a different class',
);

// The three passes must not both claim the same text, or one region would be
// edited twice and the result would be corrupt.
const fullyQualified = 'use App\\Filament\\PageBlocks\\About\\CompanyInfoBlock;';
assert.strictEqual(
    fqnReplacements(fullyQualified, 'PageBlocks\\About\\CompanyInfoBlock', 'Z', {
        separators: ['\\'],
        rootQualified: false,
    }).length,
    0,
    'the relative pass does not fire inside a fully qualified name',
);
assert.strictEqual(
    bareNameReplacements('PageBlocks\\About\\CompanyInfoBlock::x()', 'CompanyInfoBlock', 'Z').length,
    0,
    'the bare pass does not fire inside a qualified name',
);

// --- import statements and unused detection --------------------------------
const withUnused = `<?php

namespace App\\Filament\\Resources;

use App\\Models\\Post;
use App\\Models\\Unused;
use Filament\\Forms;
use Illuminate\\Support\\{Str, Collection};
use App\\Traits\\HasSlug;

class PostResource
{
    use HasSlug;

    /** @var Post */
    protected $model;

    public function form(): array
    {
        return [Forms\\Components\\TextInput::make(Str::slug('x'))];
    }
}
`;

const statements = importStatements(withUnused);
assert.strictEqual(statements.length, 5, 'one entry per statement, not per name');
assert.strictEqual(statements[3].grouped, true, 'the group import is marked');
assert.strictEqual(statements[3].entries.length, 2, 'the group import carries both names');
assert.strictEqual(
    withUnused.slice(statements[0].index, statements[0].index + statements[0].length),
    'use App\\Models\\Post;',
    'the recorded span covers exactly the statement',
);

assert.strictEqual(isNameUsed(withUnused, 'Post'), true, 'used in a docblock');
assert.strictEqual(isNameUsed(withUnused, 'HasSlug'), true, 'used as a trait in the class body');
assert.strictEqual(isNameUsed(withUnused, 'Forms'), true, 'used as a namespace prefix');
assert.strictEqual(isNameUsed(withUnused, 'Str'), true, 'used as a static call');
assert.strictEqual(isNameUsed(withUnused, 'Unused'), false, 'never mentioned');
assert.strictEqual(isNameUsed(withUnused, 'Collection'), false, 'a dead member of a live group import');

const dead = unusedImports(withUnused);
assert.strictEqual(dead.length, 1, 'only the wholly unused statement is reported');
assert.strictEqual(dead[0].entries[0].alias, 'Unused', 'and it is the right one');

// A group import keeping one live member must survive intact, since removing
// only the dead half would mean rewriting the statement rather than deleting it.
assert.ok(
    !dead.some((statement) => statement.grouped),
    'a partially used group import is left alone',
);

// The import block itself must not count as usage, or nothing would ever be
// reported as unused.
assert.strictEqual(
    isNameUsed('<?php\nnamespace A;\nuse App\\Models\\Unused;\n\nclass X {}\n', 'Unused'),
    false,
    'a name appearing only in its own import is unused',
);

// --- prose is not an import ------------------------------------------------
// A Laravel config returns an array and declares no type, so there is no import
// block for the parser to stop at. These are real excerpts from a project.
const configFile = `<?php

return [
    /*
    |------------------------------------------------------------------
    | Force HTTPS
    |------------------------------------------------------------------
    |
    | Enable this to force your application to use the HTTPS scheme.
    |
    */

    ForceScheme::class => true,

    // If you want to use your own DTO, you can change the link option.
    'link' => Link::class,
];
`;

assert.deepStrictEqual(collectImports(configFile), [], 'prose containing "use" yields no imports');
assert.deepStrictEqual(unusedImports(configFile), [], 'and therefore nothing to remove');

// From a test file that asserts on a string containing a namespace fragment.
assert.deepStrictEqual(
    collectImports(`<?php\nit('x', function () {\n    expect($r)->toContain('App\\\\');\n});\n`),
    [],
    'a namespace fragment inside a string is not an import',
);

// A real import in such a file must still be found.
assert.deepStrictEqual(
    collectImports("<?php\n\nuse App\\Support\\Link;\n\nreturn ['link' => Link::class];\n"),
    [{ fqn: 'App\\Support\\Link', alias: 'Link' }],
    'a genuine import in a class-less file still parses',
);

// Multi-line group imports are legal and must survive the identifier check.
assert.deepStrictEqual(
    collectImports('<?php\nuse Illuminate\\Support\\{\n    Str,\n    Collection,\n};\n').map((e) => e.alias),
    ['Str', 'Collection'],
    'a group import spanning several lines',
);

// --- usage above the class declaration -------------------------------------
// An attribute and a docblock type both sit before the class, so defining the
// body as "everything after the imports" would report these as unused.
const attributed = `<?php

namespace App\\Livewire\\Auth;

use Illuminate\\Support\\Carbon;
use Livewire\\Attributes\\Layout;
use Livewire\\Attributes\\Lazy;

/**
 * @property Carbon $lastAttemptAt
 */
#[Layout('layouts.guest')]
class Login
{
}
`;

assert.strictEqual(isNameUsed(attributed, 'Layout'), true, 'used by an attribute above the class');
assert.strictEqual(isNameUsed(attributed, 'Carbon'), true, 'used by a docblock above the class');
assert.strictEqual(isNameUsed(attributed, 'Lazy'), false, 'genuinely unused');
assert.deepStrictEqual(
    unusedImports(attributed).flatMap((s) => s.entries.map((e) => e.alias)),
    ['Lazy'],
    'only the genuinely unused import is reported',
);

// A helper file declares no type at all, so it has no import block boundary.
const helper = `<?php

use Illuminate\\Support\\Str;
use Illuminate\\Support\\Collection;

function slugify(string $value): string
{
    return Str::slug($value);
}
`;

assert.strictEqual(isNameUsed(helper, 'Str'), true, 'used inside a function in a class-less file');
assert.strictEqual(isNameUsed(helper, 'Collection'), false, 'unused in a class-less file');

// An import must never count as its own usage.
assert.strictEqual(
    isNameUsed('<?php\nuse App\\Models\\Post;\nuse App\\Other\\Post as Legacy;\n', 'Post'),
    false,
    'the name inside another import statement is not usage',
);

// --- comments, strings and brace depth -------------------------------------
assert.strictEqual(
    maskLiterals('<?php // use App\\Models\\Post;\nuse App\\Models\\Page;\n').length,
    '<?php // use App\\Models\\Post;\nuse App\\Models\\Page;\n'.length,
    'masking preserves every offset',
);

assert.deepStrictEqual(
    collectImports('<?php\n// use Illuminate\\Contracts\\Auth\\MustVerifyEmail;\nuse App\\Models\\Post;\n').map(
        (e) => e.alias,
    ),
    ['Post'],
    'a commented-out import is not an import',
);

assert.deepStrictEqual(
    collectImports('<?php\n/* use App\\Old\\Thing; */\nuse App\\Models\\Post;\n').map((e) => e.alias),
    ['Post'],
    'a block-commented import is not an import',
);

assert.deepStrictEqual(
    collectImports("<?php\n$sql = 'use App\\\\Old;';\nuse App\\Models\\Post;\n").map((e) => e.alias),
    ['Post'],
    'an import inside a string is not an import',
);

// A trait use inside an anonymous class: no line-anchored search for a class
// declaration can see `new class {`, so brace depth is what rules it out.
assert.deepStrictEqual(
    collectImports(`<?php
use Afsakar\\Concerns\\InteractsWithAuditDiffs;

it('compares', function () {
    $subject = new class {
        use InteractsWithAuditDiffs;
    };
});
`).map((e) => e.alias),
    ['InteractsWithAuditDiffs'],
    'a trait use inside an anonymous class is not a second import',
);

// And the import is then correctly seen as used by that trait use.
assert.strictEqual(
    isNameUsed(
        `<?php
use Afsakar\\Concerns\\InteractsWithAuditDiffs;

it('compares', function () {
    $subject = new class {
        use InteractsWithAuditDiffs;
    };
});
`,
        'InteractsWithAuditDiffs',
    ),
    true,
    'the trait use counts as usage of the import',
);

console.log('all assertions passed');
