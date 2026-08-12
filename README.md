# PHP Namespace Tools

PhpStorm resolves a class against the namespaces you have already imported. Given
`use Filament\Forms;` in the file, picking `TextInput` from the completion list
inserts `Forms\Components\TextInput` and leaves the import block alone.

Every VS Code PHP language server instead adds a second `use` statement and
writes the bare short name. This extension adds the missing behaviour.

## Example

```php
use Filament\Forms;

// Type `TextI`, pick the suggestion:
Forms\Components\TextInput::make('title')

// Instead of a new `use Filament\Forms\Components\TextInput;`
// plus a bare `TextInput::make('title')`
```

## How it works

The extension does not build its own index. On each completion request it asks
VS Code for workspace symbols matching the typed prefix, which is answered by
whichever PHP language server you already run. Each result's fully qualified name
is matched against the `use` statements in the current file, and the longest
matching import becomes the prefix.

Consequences worth knowing:

- A PHP language server that indexes your project is required. Any of
  Intelephense, DevSense PHP Tools or Phpactor works.
- Running several language servers at once produces duplicate and
  poorly ordered suggestions. Enable exactly one.
- Suggestions only appear for namespaces you have already imported. This is
  deliberate: the extension never adds an import, it only reuses one.

## Shorten a qualified name

Put the cursor on a fully qualified name anywhere in a file — including inside a
docblock, where no language server offers to help — and the lightbulb offers to
shorten it. Exactly one offer is made, decided by what the file already imports:

```php
/** @use HasFactory<\Database\Factories\Corporate\ProductFactory> */

// nothing imported      -> adds `use Database\Factories\Corporate\ProductFactory;`
//                          and leaves `HasFactory<ProductFactory>`
// parent namespace in   -> `HasFactory<Corporate\ProductFactory>`, no new import
// class already in      -> `HasFactory<ProductFactory>`, no new import
// short name taken      -> nothing offered, since importing would change what
//                          the existing name resolves to
```

A new import is sorted into the existing block, or opens one after the
`namespace` statement when there is none.

The reverse works too. On an unqualified class name the file does not resolve,
the lightbulb offers an import per class carrying that name, taken from the
workspace symbol index. A name already imported, declared in this file, or
living in this file's own namespace resolves as it stands and is passed over.

To be offered anything the name must begin with an upper case letter, as PSR-1
requires of a class. Without that rule every lower case identifier in the file
would raise an offer.

The quick fix acts on the name under the cursor. To do a whole file at once run
**PHP Namespace Tools: Shorten All Qualified Names**, which applies the same
decision to every name in document order. A class is imported once however many
times it appears, and when two different classes share a short name the first
one takes it while the rest are left fully qualified and listed in the output
channel — importing both would leave the file compiling with one of the names
resolving to the wrong class.

## Namespace on move

Moving a PHP file changes the namespace PSR-4 requires it to declare. VS Code
moves the file and leaves the stale declaration behind, so the class stops
autoloading. This extension rewrites that declaration from the `autoload` and
`autoload-dev` PSR-4 maps in `composer.json`, renames the class when the file
name changes, then repoints every reference across the project.

Everything a move rewrites is listed in the **PHP Namespace Tools** output
channel, and VS Code folds the edits into the same undo step as the move.

Read the ceiling before relying on it:

- **References are matched in all three spellings**: fully qualified, written
  relative to an imported parent namespace (`PageBlocks\About\CompanyInfoBlock`
  under `use App\Filament\PageBlocks;`), and bare. Matching is textual, not
  driven by the reference provider. That is what lets plain strings such as
  `'App\Models\User'` in a config file be repointed, which no PHP language
  server resolves. Comments naming the class are rewritten too.
- **Referencing files are found through `findFiles`**, so a path hidden by your
  `files.exclude` or `search.exclude` is never visited and keeps a stale import.
- **Directory moves are handled**, by enumerating the PHP files beneath the
  moved directory. Moves above `maximumFilesPerMove` files are refused outright.
- **A class is renamed only when it was named after its file.** `Foo.php`
  holding `class Foo` becomes `class Bar` when renamed to `Bar.php`; a file
  holding a differently named class is treated as moved, not renamed.
- **Bare names are rewritten only where they resolve to the renamed class**:
  files importing it unaliased, declaring it, or sharing its namespace. A name
  touching a quote is skipped, so a `'RichTextBlock'` key stays put — which also
  means a class name genuinely stored as a string is left behind.

Set `phpNamespaceTools.updateNamespaceOnMove` to `false` to turn it off.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `phpNamespaceTools.enabled` | `true` | Offer relative-namespace completions. |
| `phpNamespaceTools.minimumPrefixLength` | `3` | Characters typed before the symbol index is queried. Raise it if completion feels slow. |
| `phpNamespaceTools.maximumSuggestions` | `25` | Maximum relative suggestions per request. |
| `phpNamespaceTools.updateNamespaceOnMove` | `true` | Rewrite the namespace declaration of a moved file. |
| `phpNamespaceTools.maximumFilesPerMove` | `500` | Refuse a move touching more PHP files than this. |
| `phpNamespaceTools.updateImportsOnMove` | `true` | Repoint references to a moved class across the project. |

## Troubleshooting

Run **PHP Namespace Tools: Debug Workspace Symbols** from the command palette
and enter a class name. The output channel shows what the language server
returned and how the current file's imports were parsed. If the symbol list is
empty or `containerName` carries no namespace, the language server is the
problem, not this extension.

## Development

```bash
npm test                      # pure parsing logic, no VS Code required
npx @vscode/vsce package      # build the .vsix
```

`npm test` stubs the `vscode` module so the import parsing and namespace
rewriting can be exercised in plain Node.

## Licence

MIT
