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

console.log('all assertions passed');
