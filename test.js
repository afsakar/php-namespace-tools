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
    bareNameAt,
    importStatements,
    unusedImports,
    bladeImports,
    bladeImportInsertion,
    importsOf,
    namespaceRelative,
    shortestRelative,
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

// Both classes sit under the file's own namespace, so each gets a distinct
// spelling PHP resolves and neither needs an import at all.
const sameTree = [
    '<?php', `namespace App;`, '',
    'class Report', '{',
    `    public function a(${B}App${B}Pdf${B}Writer $w) {}`,
    `    public function b(${B}App${B}Csv${B}Writer $w) {}`,
    '}', '',
].join('\n');

const resolved = apply(sameTree);
assert.strictEqual(resolved.plan.skipped.length, 0, 'a sub-namespace spelling avoids the clash entirely');
assert.ok(resolved.result.includes(`a(Pdf${B}Writer $w)`), 'the first is written against the namespace');
assert.ok(resolved.result.includes(`b(Csv${B}Writer $w)`), 'so is the second');
assert.ok(!resolved.result.includes('use App'), 'and neither needed an import');

// Two different classes sharing a short name, neither reachable through the
// current namespace: the first wins, the second stays qualified rather than
// silently resolving to the first.
const clashing = [
    '<?php', `namespace App;`, '',
    'class Report', '{',
    `    public function a(${B}Vendor${B}Pdf${B}Writer $w) {}`,
    `    public function b(${B}Vendor${B}Csv${B}Writer $w) {}`,
    '}', '',
].join('\n');

const conflicted = apply(clashing);
assert.strictEqual(conflicted.plan.skipped.length, 1, 'one name is reported as skipped');
assert.strictEqual(conflicted.plan.skipped[0], `Vendor${B}Csv${B}Writer`, 'the later one is skipped');
assert.ok(conflicted.result.includes(`use Vendor${B}Pdf${B}Writer;`), 'the first is imported');
assert.ok(!conflicted.result.includes(`use Vendor${B}Csv${B}Writer;`), 'the second is not imported');
assert.ok(conflicted.result.includes(`b(${B}Vendor${B}Csv${B}Writer $w)`), 'the second is left fully qualified');

// Repeat occurrences of one class share a single import. The class sits
// outside the file's namespace, so an import is genuinely needed.
const repeated = [
    '<?php', `namespace App;`, '',
    'class Report', '{',
    `    public function a(${B}Vendor${B}Pdf${B}Writer $w) {}`,
    `    public function b(${B}Vendor${B}Pdf${B}Writer $w) {}`,
    '}', '',
].join('\n');

const twice = apply(repeated);
assert.strictEqual(twice.plan.replacements.length, 2, 'both occurrences shortened');
assert.strictEqual(
    twice.result.split('\n').filter((line) => line === `use Vendor${B}Pdf${B}Writer;`).length,
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

// --- unqualified name under the cursor -------------------------------------
const usage = 'public function scopeActive(Builder $query): Model {}';

assert.strictEqual(bareNameAt(usage, usage.indexOf('Builder') + 2).name, 'Builder', 'a parameter type');
assert.strictEqual(bareNameAt(usage, usage.indexOf('Model') + 2).name, 'Model', 'a return type');
assert.strictEqual(bareNameAt(usage, usage.indexOf('$query') + 2), null, 'a variable');
assert.strictEqual(bareNameAt(usage, usage.indexOf('function') + 2), null, 'a lower case keyword');

const qualified = 'new App\\Models\\Product();';
assert.strictEqual(
    bareNameAt(qualified, qualified.indexOf('Product') + 2),
    null,
    'a segment of a qualified name belongs to the other reader',
);
assert.strictEqual(
    bareNameAt(qualified, qualified.indexOf('App') + 1),
    null,
    'the leading segment of a qualified name too',
);

assert.strictEqual(bareNameAt('$this->Product', 10), null, 'a property');
assert.strictEqual(bareNameAt('self::Product', 8), null, 'a static member');
assert.strictEqual(bareNameAt('$Product = 1;', 3), null, 'a variable named like a class');

// PSR-1 requires StudlyCaps, and the rule is what keeps every lower case
// identifier in the file from raising an offer.
assert.strictEqual(bareNameAt('return $x;', 2), null, 'return');
assert.strictEqual(bareNameAt('array $items', 2), null, 'a scalar type name');

const docblockUse = '     * @param Builder $query';
assert.strictEqual(
    bareNameAt(docblockUse, docblockUse.indexOf('Builder') + 3).name,
    'Builder',
    'inside a docblock, where no language server offers anything',
);

// --- unused imports --------------------------------------------------------
const SEP = String.fromCharCode(92);
const withUnused = [
    '<?php', '',
    `namespace App${SEP}Models;`, '',
    `use App${SEP}Enums${SEP}Status;`,
    `use Illuminate${SEP}Database${SEP}Eloquent${SEP}Model;`,
    `use Illuminate${SEP}Database${SEP}Eloquent${SEP}Factories${SEP}HasFactory;`,
    `use Illuminate${SEP}Support${SEP}Carbon;`,
    `use Filament${SEP}Forms;`,
    `use App${SEP}Contracts${SEP}Sluggable as Slug;`,
    `use App${SEP}Enums${SEP}Unused;`, '',
    'class Product extends Model',
    '{',
    '    use HasFactory;', '',
    '    #[ObservedBy(Status::class)]',
    `    public array $schema = [Forms${SEP}Components${SEP}TextInput::class];`, '',
    '    /** @var Slug|null */',
    '    public $slug;', '',
    '    // Carbon is mentioned only here',
    '}', ''].join('\n');

const dead = unusedImports(withUnused).map((entry) => entry.alias);

assert.deepStrictEqual(dead, ['Unused'], 'only the genuinely unreferenced import is reported');

const kept = (alias, why) =>
    assert.ok(!dead.includes(alias), `${alias} is kept: ${why}`);

kept('Model', 'used in an extends clause');
kept('HasFactory', 'used by a trait use inside the class body');
kept('Status', 'used inside an attribute');
kept('Forms', 'used as the prefix of a partially qualified name');
kept('Slug', 'used only in a docblock, which no language server reads');
kept('Carbon', 'mentioned only in a comment, and guessing wrong here breaks the file');

// Whole-line spans, so removal cannot leave a fragment behind.
const [only] = unusedImports(withUnused);
assert.strictEqual(
    withUnused.slice(only.start, only.end),
    `use App${SEP}Enums${SEP}Unused;` + '\n',
    'the span covers the entire line including its terminator',
);
assert.strictEqual(
    withUnused.slice(0, only.start) + withUnused.slice(only.end),
    withUnused.replace(`use App${SEP}Enums${SEP}Unused;` + '\n', ''),
    'removing the span leaves the rest of the file intact',
);

// Shapes that must never be offered for removal.
assert.deepStrictEqual(
    importStatements(`<?php\nuse A${SEP}B; use C${SEP}D;\n\nclass X {}\n`).map((e) => e.alias),
    [],
    'two statements sharing a line are left alone',
);
assert.deepStrictEqual(
    importStatements(`<?php\nuse A${SEP}{B, C};\n\nclass X {}\n`).map((e) => e.alias),
    [],
    'a group import would need rewriting, not deleting',
);
assert.deepStrictEqual(
    importStatements(`<?php\nuse function A${SEP}b;\nuse const A${SEP}C;\n\nclass X {}\n`).map((e) => e.alias),
    [],
    'function and const imports are a separate resolution space',
);

// An anonymous class opens a body mid-expression. Taken from a real Pest test
// that returned `new class($a, $b) { use InteractsWithAuditDiffs; ... }`, where
// the trait use was read as an import and reported as unused — removing it
// would have deleted a trait the class depends on.
const anonymous = [
    '<?php', '',
    `use Afsakar${SEP}FilamentAuditingPlugin${SEP}Concerns${SEP}InteractsWithAuditDiffs;`,
    `use OwenIt${SEP}Auditing${SEP}Models${SEP}Audit;`, '',
    'function makeHarness(?Audit $selected = null): object',
    '{',
    '    return new class($selected)',
    '    {',
    '        use InteractsWithAuditDiffs;',
    '    };',
    '}', ''].join('\n');

assert.deepStrictEqual(
    collectImports(anonymous).map((entry) => entry.alias),
    ['InteractsWithAuditDiffs', 'Audit'],
    'a trait use inside an anonymous class is not an import',
);
assert.deepStrictEqual(
    unusedImports(anonymous).map((entry) => entry.alias),
    [],
    'and the trait it names counts as using the import',
);

// --- names resolved against the file's own namespace -----------------------
// From a real DatabaseSeeder, which writes `Corporate\\ProductSeeder::class`
// inside `namespace Database\\Seeders;` with no import for it at all.
const seederImports2 = collectImports(
    `<?php${String.fromCharCode(10)}use Illuminate${SEP}Database${SEP}Seeder;${String.fromCharCode(10)}`,
);

assert.strictEqual(
    namespaceRelative(`Database${SEP}Seeders${SEP}Corporate${SEP}ProductSeeder`, `Database${SEP}Seeders`, seederImports2),
    `Corporate${SEP}ProductSeeder`,
    'a class in a sub-namespace of the current one',
);

// A class sitting directly in the namespace already resolves bare.
assert.strictEqual(
    namespaceRelative(`Database${SEP}Seeders${SEP}SettingSeeder`, `Database${SEP}Seeders`, seederImports2),
    null,
    'a sibling class needs no qualification',
);

assert.strictEqual(
    namespaceRelative(`App${SEP}Models${SEP}User`, `Database${SEP}Seeders`, seederImports2),
    null,
    'a class outside the namespace',
);

// PHP checks the leading segment against imports before the current namespace,
// so writing `Corporate\ProductSeeder` here would resolve to Vendor\Corporate.
const shadowed = collectImports(`<?php${String.fromCharCode(10)}use Vendor${SEP}Corporate;${String.fromCharCode(10)}`);
assert.strictEqual(
    namespaceRelative(`Database${SEP}Seeders${SEP}Corporate${SEP}ProductSeeder`, `Database${SEP}Seeders`, shadowed),
    null,
    'an import shadowing the leading segment rules the spelling out',
);

// The shorter of the two spellings wins.
const both = collectImports(`<?php${String.fromCharCode(10)}use Database${SEP}Seeders${SEP}Corporate${SEP}Deep;${String.fromCharCode(10)}`);
assert.strictEqual(
    shortestRelative(`Database${SEP}Seeders${SEP}Corporate${SEP}Deep${SEP}Thing`, both, `Database${SEP}Seeders`),
    `Deep${SEP}Thing`,
    'an import gives a shorter spelling than the namespace here',
);
assert.strictEqual(
    shortestRelative(`Database${SEP}Seeders${SEP}Corporate${SEP}ProductSeeder`, seederImports2, `Database${SEP}Seeders`),
    `Corporate${SEP}ProductSeeder`,
    'the namespace is used when no import covers the class',
);

// --- Blade @use directives -------------------------------------------------
// Every spelling Laravel's CompilesUseStatements accepts.
const blade = [
    `@use('App${SEP}Enums${SEP}Status')`,
    `@use(App${SEP}Models${SEP}User)`,
    `@use('App${SEP}Contracts${SEP}Sluggable', 'Slug')`,
    `@use('Illuminate${SEP}Support${SEP}{Str, Collection}')`,
    `@use('function App${SEP}Helpers${SEP}money')`,
    `@use('const App${SEP}SOME_FLAG')`,
    '',
    '<div>{{ Status::Active->label() }}</div>',
].join('\n');

const bladeParsed = bladeImports(blade);
const bladeAlias = (alias) => bladeParsed.find((entry) => entry.alias === alias);

assert.deepStrictEqual(bladeAlias('Status'), { fqn: `App${SEP}Enums${SEP}Status`, alias: 'Status' }, 'quoted');
assert.deepStrictEqual(bladeAlias('User'), { fqn: `App${SEP}Models${SEP}User`, alias: 'User' }, 'unquoted');
assert.deepStrictEqual(
    bladeAlias('Slug'),
    { fqn: `App${SEP}Contracts${SEP}Sluggable`, alias: 'Slug' },
    'the second segment is an alias',
);
assert.deepStrictEqual(bladeAlias('Str'), { fqn: `Illuminate${SEP}Support${SEP}Str`, alias: 'Str' }, 'group member');
assert.deepStrictEqual(
    bladeAlias('Collection'),
    { fqn: `Illuminate${SEP}Support${SEP}Collection`, alias: 'Collection' },
    'second group member',
);
assert.strictEqual(bladeParsed.length, 5, 'function and const directives are skipped');

// A Blade file may carry both syntaxes.
const mixed = [
    `@use('App${SEP}Enums${SEP}Status')`,
    '@php',
    `use App${SEP}Models${SEP}User;`,
    '@endphp',
].join('\n');

assert.deepStrictEqual(
    importsOf(mixed, 'blade').map((entry) => entry.alias).sort(),
    ['Status', 'User'],
    'a @php block and a @use directive are both imports',
);

// A PHP docblock generic must never be read as a Blade directive.
assert.deepStrictEqual(
    importsOf(`<?php${String.fromCharCode(10)}/** @use HasFactory<${SEP}Db${SEP}F> */${String.fromCharCode(10)}`, 'php'),
    [],
    'the docblock @use tag is not a directive',
);

// --- where a @use directive goes -------------------------------------------
const bladeBlock = [
    `@use('App${SEP}Enums${SEP}Status')`,
    `@use('Illuminate${SEP}Support${SEP}Str')`,
    '',
    '<div></div>',
    '',
].join('\n');

const intoBladeBlock = bladeImportInsertion(bladeBlock, `App${SEP}Models${SEP}User`);
assert.strictEqual(
    bladeBlock.slice(0, intoBladeBlock.index) + intoBladeBlock.text + bladeBlock.slice(intoBladeBlock.index),
    [
        `@use('App${SEP}Enums${SEP}Status')`,
        `@use('App${SEP}Models${SEP}User')`,
        `@use('Illuminate${SEP}Support${SEP}Str')`,
        '',
        '<div></div>',
        '',
    ].join('\n'),
    'sorts into the existing run of directives',
);

const bladeEmpty = '<div>{{ $x }}</div>\n';
const opensBlade = bladeImportInsertion(bladeEmpty, `App${SEP}Enums${SEP}Status`);
assert.strictEqual(
    bladeEmpty.slice(0, opensBlade.index) + opensBlade.text + bladeEmpty.slice(opensBlade.index),
    `@use('App${SEP}Enums${SEP}Status')\n<div>{{ $x }}</div>\n`,
    'opens the file when there is nothing to join',
);

console.log('all assertions passed');
