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
    qualifiedNameAt,
    importInsertion,
    qualifiedNameOccurrences,
    shortenAllPlan,
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

// --- qualified name under the cursor ---------------------------------------
// The case this exists for: a generic annotation in a Laravel model docblock.
const docblock = '    /** @use HasFactory<\\Database\\Factories\\Corporate\\ProductFactory> */';
const inGeneric = qualifiedNameAt(docblock, docblock.indexOf('ProductFactory') + 4);

assert.strictEqual(
    inGeneric.fqn,
    'Database\\Factories\\Corporate\\ProductFactory',
    'reads the name out of a generic docblock tag',
);
assert.strictEqual(
    docblock.slice(inGeneric.index, inGeneric.index + inGeneric.length),
    '\\Database\\Factories\\Corporate\\ProductFactory',
    'the span covers the leading separator so it is replaced too',
);

// The angle brackets must bound the span on both sides.
assert.strictEqual(qualifiedNameAt(docblock, docblock.indexOf('HasFactory') + 2), null, 'a bare name is already short');

const call = 'return \\App\\Models\\User::class;';
const inCall = qualifiedNameAt(call, call.indexOf('Models') + 2);
assert.strictEqual(inCall.fqn, 'App\\Models\\User', 'stops at ::');
assert.strictEqual(call.slice(inCall.index, inCall.index + inCall.length), '\\App\\Models\\User', 'span');

const unqualified = 'new App\\Models\\User();';
assert.strictEqual(
    qualifiedNameAt(unqualified, unqualified.indexOf('User') + 1).fqn,
    'App\\Models\\User',
    'a name without a leading separator',
);

assert.strictEqual(qualifiedNameAt('$user = 1;', 3), null, 'not a name at all');
assert.strictEqual(qualifiedNameAt('use App\\Models\\;', 12), null, 'a trailing separator names nothing');

// --- where a use statement goes --------------------------------------------
const withBlock = `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Support\\Str;

class Product extends Model {}
`;

const intoBlock = importInsertion(withBlock, 'Database\\Factories\\Corporate\\ProductFactory');
assert.strictEqual(
    withBlock.slice(0, intoBlock.index) + intoBlock.text + withBlock.slice(intoBlock.index),
    withBlock.replace(
        'use Illuminate\\Database',
        'use Database\\Factories\\Corporate\\ProductFactory;\nuse Illuminate\\Database',
    ),
    'sorts into an existing block',
);

const appended = importInsertion(withBlock, 'Zzz\\Last');
assert.ok(
    (withBlock.slice(0, appended.index) + appended.text + withBlock.slice(appended.index)).includes(
        'use Illuminate\\Support\\Str;\nuse Zzz\\Last;\n',
    ),
    'appends after the last import when it sorts last',
);

const noBlock = '<?php\n\nnamespace App\\Models;\n\nclass Product {}\n';
const afterNamespace = importInsertion(noBlock, 'App\\Support\\Helper');
assert.strictEqual(
    noBlock.slice(0, afterNamespace.index) + afterNamespace.text + noBlock.slice(afterNamespace.index),
    '<?php\n\nnamespace App\\Models;\n\nuse App\\Support\\Helper;\n\nclass Product {}\n',
    'opens a block after the namespace statement',
);

const noNamespace = '<?php\n\nclass Product {}\n';
const afterTag = importInsertion(noNamespace, 'App\\Support\\Helper');
assert.strictEqual(
    noNamespace.slice(0, afterTag.index) + afterTag.text + noNamespace.slice(afterTag.index),
    '<?php\n\nuse App\\Support\\Helper;\n\nclass Product {}\n',
    'falls back to the opening tag',
);

// --- shortening every name in a file ---------------------------------------
const B = String.fromCharCode(92);

const apply = (text) => {
    const plan = shortenAllPlan(text);
    let result = text;
    const edits = [
        ...plan.replacements.map((e) => ({ index: e.index, length: e.length, text: e.replacement })),
        ...plan.insertions.map((e) => ({ index: e.index, length: 0, text: e.text })),
    ].sort((a, b) => b.index - a.index || b.length - a.length);
    for (const e of edits) {
        result = result.slice(0, e.index) + e.text + result.slice(e.index + e.length);
    }
    return { result, plan };
};

const many = [
    '<?php', '',
    `namespace App${B}Models;`, '',
    `use Illuminate${B}Database${B}Eloquent${B}Model;`, '',
    'class Product extends Model', '{',
    `    /** @use HasFactory<${B}Database${B}Factories${B}ProductFactory> */`,
    `    protected $casts = [${B}App${B}Enums${B}Status::class];`,
    `    public function scope(${B}Illuminate${B}Database${B}Eloquent${B}Builder $q) {}`,
    '}', '',
].join('\n');

const bulk = apply(many);
assert.strictEqual(bulk.plan.replacements.length, 3, 'every qualified name is planned');
assert.ok(bulk.result.includes(`use Database${B}Factories${B}ProductFactory;`), 'factory imported');
assert.ok(bulk.result.includes(`use App${B}Enums${B}Status;`), 'enum imported');
assert.ok(bulk.result.includes(`use Illuminate${B}Database${B}Eloquent${B}Builder;`), 'builder imported');
assert.ok(bulk.result.includes('HasFactory<ProductFactory>'), 'docblock shortened');
assert.ok(bulk.result.includes('[Status::class]'), 'attribute shortened');
assert.ok(bulk.result.includes('scope(Builder $q)'), 'parameter shortened');

// The import block must come out sorted, with the pre-existing entry in place.
const useLines = bulk.result.split('\n').filter((line) => line.startsWith('use '));
assert.deepStrictEqual(useLines, [...useLines].sort(), 'the block is left in alphabetical order');
assert.strictEqual(useLines.length, 4, 'three added to the one already there');

// The namespace statement and the existing import are declarations, not
// references, and must never be rewritten.
assert.ok(bulk.result.includes(`namespace App${B}Models;`), 'the namespace statement is untouched');

// Two different classes sharing a short name: the first wins, the second stays
// qualified rather than silently resolving to the first.
const clashing = [
    '<?php', `namespace App;`, '',
    'class Report', '{',
    `    public function a(${B}App${B}Pdf${B}Writer $w) {}`,
    `    public function b(${B}App${B}Csv${B}Writer $w) {}`,
    '}', '',
].join('\n');

const conflicted = apply(clashing);
assert.strictEqual(conflicted.plan.skipped.length, 1, 'one name is reported as skipped');
assert.strictEqual(conflicted.plan.skipped[0], `App${B}Csv${B}Writer`, 'the later one is skipped');
assert.ok(conflicted.result.includes(`use App${B}Pdf${B}Writer;`), 'the first is imported');
assert.ok(!conflicted.result.includes(`use App${B}Csv${B}Writer;`), 'the second is not imported');
assert.ok(conflicted.result.includes(`b(${B}App${B}Csv${B}Writer $w)`), 'the second is left fully qualified');

// Repeat occurrences of one class share a single import.
const repeated = [
    '<?php', `namespace App;`, '',
    'class Report', '{',
    `    public function a(${B}App${B}Pdf${B}Writer $w) {}`,
    `    public function b(${B}App${B}Pdf${B}Writer $w) {}`,
    '}', '',
].join('\n');

const twice = apply(repeated);
assert.strictEqual(twice.plan.replacements.length, 2, 'both occurrences shortened');
assert.strictEqual(
    twice.result.split('\n').filter((line) => line === `use App${B}Pdf${B}Writer;`).length,
    1,
    'imported once',
);

// A name only reachable through an imported parent namespace costs no import.
const viaParent = [
    '<?php', `namespace App;`, '',
    `use Database${B}Factories;`, '',
    'class Product', '{',
    `    /** @use HasFactory<${B}Database${B}Factories${B}ProductFactory> */`,
    '}', '',
].join('\n');

const relative = apply(viaParent);
assert.strictEqual(relative.plan.insertions.length, 0, 'no import is added');
assert.ok(relative.result.includes(`HasFactory<Factories${B}ProductFactory>`), 'written against the parent');

// Occurrence scanning must ignore declarations outright.
const decls = `<?php\nnamespace App${B}Models;\n\nuse Illuminate${B}Support${B}Str;\n\nclass P {}\n`;
assert.deepStrictEqual(qualifiedNameOccurrences(decls), [], 'namespace and imports are not occurrences');

console.log('all assertions passed');
