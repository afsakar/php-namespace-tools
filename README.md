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

## Namespace on move

Moving a PHP file changes the namespace PSR-4 requires it to declare. VS Code
moves the file and leaves the stale declaration behind, so the class stops
autoloading. This extension rewrites that declaration from the `autoload` and
`autoload-dev` PSR-4 maps in `composer.json`.

Read the ceiling before relying on it:

- **Only the moved file is edited.** Every `use` statement pointing at the old
  name elsewhere in the project is left untouched, and your language server will
  report them as unresolved. Updating them is not implemented yet.
- **Directory moves are handled**, by enumerating the PHP files beneath the
  moved directory. Moves above `maximumFilesPerMove` files are refused outright.
- **The class name is never changed.** Renaming `Foo.php` to `Bar.php` updates
  nothing, because rewriting the declaration alone would silently break every
  caller.

Set `phpNamespaceTools.updateNamespaceOnMove` to `false` to turn it off.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `phpNamespaceTools.enabled` | `true` | Offer relative-namespace completions. |
| `phpNamespaceTools.minimumPrefixLength` | `3` | Characters typed before the symbol index is queried. Raise it if completion feels slow. |
| `phpNamespaceTools.maximumSuggestions` | `25` | Maximum relative suggestions per request. |
| `phpNamespaceTools.updateNamespaceOnMove` | `true` | Rewrite the namespace declaration of a moved file. |
| `phpNamespaceTools.maximumFilesPerMove` | `500` | Refuse a move touching more PHP files than this. |

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
