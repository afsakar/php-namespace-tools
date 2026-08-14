# PHP Namespace Tools

Namespace-aware refactoring and import handling for PHP and Blade in VS Code.

Moving or renaming a PHP file breaks it: PSR-4 ties the namespace to the
directory and the class to the file name, so the declaration goes stale and
every reference to it dangles. This extension keeps them in step, and handles
the import block around it.

- **Move a file or a directory** — the `namespace` follows the PSR-4 mapping and
  every reference across the project is repointed
- **Rename a file** — the class is renamed with it, references follow
- **Namespace conformance** — a declaration the directory does not imply is
  flagged, with a fix
- **Unused imports** — faded in place, removed on request, never on their own
- **Shorten a qualified name** — reuse an import you already have, or add one
- **Import an unresolved name** — one offer per candidate class
- **Blade** — the same completion and fixes, through `@use`

## Requirements

A PHP language server that indexes your project: Intelephense, DEVSENSE PHP
Tools or Phpactor. This extension builds no index of its own and asks VS Code
for workspace symbols, which whichever server you run answers.

Enable exactly one. Several at once produce duplicate and poorly ordered
suggestions, from this extension and from the editor generally.

---

## Move a file

Moving a PHP file changes the namespace PSR-4 requires it to declare. VS Code
moves the file and leaves the stale declaration behind, so the class stops
autoloading. The declaration is rewritten from the `autoload` and `autoload-dev`
PSR-4 maps in `composer.json`, the class is renamed when the file name changes,
and every reference across the project is repointed.

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

## Rename a class

**Rename Class and File** renames the class in the active editor and its file
together, then repoints every reference. PSR-4 ties the two names to each other,
so renaming either alone stops the class autoloading.

The command refuses when the file declares no type, and when the declared type
is not named after the file — there the two names are already independent and
guessing which one was meant would be wrong. An existing file at the target name
is never overwritten.

The edits and the rename travel in one workspace edit, so `Cmd+Z` undoes the
whole thing and the open editor follows the file to its new path.

## Namespace conformance

A file whose `namespace` does not match its composer PSR-4 directory is flagged,
with a quick fix that corrects the declaration.

This exists because moves are only followed when VS Code performs them. A file
moved by git, by `mv`, by a merge or by another editor keeps a namespace that no
longer autoloads, and nothing else in the editor says so.

Files outside every PSR-4 root, and files declaring no type at all, have nothing
to conform to and are never flagged.

---

## Completion

PhpStorm resolves a class against the namespaces you have already imported.
Given `use Filament\Forms;` in the file, picking `TextInput` from the completion
list inserts `Forms\Components\TextInput` and leaves the import block alone:

```php
use Filament\Forms;

// Type `TextI`, pick the suggestion:
Forms\Components\TextInput::make('title')

// Instead of a new `use Filament\Forms\Components\TextInput;`
// plus a bare `TextInput::make('title')`
```

Suggestions appear only for namespaces already imported, or for classes under
the file's own namespace. The completion never adds an import; it only reuses
what already resolves.

A class in a sub-namespace of the file's own needs no import at all, because PHP
resolves a qualified name against the current namespace. Typing `ProductSeeder`
inside `namespace Database\Seeders;` therefore offers `Corporate\ProductSeeder`,
the spelling a Laravel `DatabaseSeeder` already uses. The offer is withheld when
the leading segment is an imported alias, since PHP checks imports first and the
name would resolve elsewhere.

Intelephense can do part of this natively — see
`intelephense.completion.suggestRelativeToPartialUseDeclaration`, which is off
by default and covers `use` statements but not the current namespace.

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

**Shorten All Qualified Names** applies the same decision to every name in the
file, in document order. A class is imported once however many times it appears,
and when two different classes share a short name the first one takes it while
the rest are left fully qualified and listed in the output channel — importing
both would leave the file compiling with one of the names resolving to the wrong
class.

## Import an unresolved name

On an unqualified class name the file does not resolve, the lightbulb offers an
import per class carrying that name, taken from the workspace symbol index.
Where an imported parent namespace already covers the class, the relative
spelling is offered instead and no import is added.

A name already imported, declared in this file, or living in this file's own
namespace resolves as it stands and is passed over.

To be offered anything the name must begin with an upper case letter, as PSR-1
requires of a class. Without that rule every lower case identifier in the file
would raise an offer.

## Unused imports

Imports the open file never refers to are faded in place, each carrying a quick
fix that removes it. **Remove Unused Imports** clears them all at once.

Nothing is ever removed on its own. There is no save-time action, so a removal
only happens when you ask for one.

> If imports vanish on save, this extension is not doing it. Laravel's own VS
> Code extension can run Pint on save (`Laravel.pint.runOnSave`), and Pint's
> `laravel` preset applies `no_unused_imports`.

The search is deliberately reluctant. An alias mentioned in a comment or inside
a string counts as used, because the two mistakes are not equal: keeping a
redundant import is noise, while deleting a needed one stops the file compiling.
For the same reason three shapes are never touched:

- two statements sharing a line, whose spans would overlap
- group imports, where dropping one member means rewriting the statement
- `use function` and `use const`, a separate resolution space

Usages inside docblocks, attributes, `implements` clauses and trait `use`
statements all count, including inside an anonymous class body.

---

## Blade templates

The completion and both quick fixes work in Blade templates as well, using the
`@use` directive Laravel 11 introduced rather than a PHP `use` statement:

```blade
@use('App\Enums\Status')

<span>{{ Status::Active->label() }}</span>
```

Existing directives are read in every spelling Laravel's own compiler accepts —
quoted or bare, with an alias as a second argument, and the group form. A `@php`
block's plain `use` statements count as imports too. A new directive joins the
existing run in alphabetical order, or opens the file when there is none.

The `@use` tag inside a PHP docblock is never mistaken for a directive.

Unused imports and the PSR-4 check stay PHP only: a template has no namespace to
conform to.

## Selecting a variable

Double clicking `$property` selects only `property`, because VS Code treats `$`
as a word separator. PhpStorm selects the whole variable.

The extension ships a language-scoped default that drops `$` from
`editor.wordSeparators` for PHP and Blade, so a double click takes the whole
variable and word-wise cursor movement stops at its edges. It is only a default;
setting `editor.wordSeparators` yourself overrides it.

---

## Commands

All are prefixed **PHP Namespace Tools** in the command palette.

| Command | What it does |
| --- | --- |
| Rename Class and File | Renames the class and its file together, repointing references. |
| Shorten All Qualified Names | Shortens every qualified name in the file, adding imports as needed. |
| Remove Unused Imports | Deletes the `use` statements the file never refers to. |
| Debug Workspace Symbols | Reports what the language server returns, for troubleshooting. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `phpNamespaceTools.enabled` | `true` | Offer completions and the shortening quick fixes. |
| `phpNamespaceTools.minimumPrefixLength` | `3` | Characters typed before the symbol index is queried. Raise it if completion feels slow. |
| `phpNamespaceTools.maximumSuggestions` | `25` | Maximum relative suggestions per request. |
| `phpNamespaceTools.updateNamespaceOnMove` | `true` | Rewrite the namespace declaration of a moved file. |
| `phpNamespaceTools.updateImportsOnMove` | `true` | Repoint references to a moved class across the project. |
| `phpNamespaceTools.maximumFilesPerMove` | `500` | Refuse a move touching more PHP files than this. |
| `phpNamespaceTools.validateNamespace` | `true` | Warn when a namespace does not match its PSR-4 directory. |
| `phpNamespaceTools.flagUnusedImports` | `true` | Fade imports the file never refers to. |

## Troubleshooting

Run **Debug Workspace Symbols** from the command palette and enter a class name.
The output channel shows what the language server returned, how the current
file's imports were parsed, the namespace PSR-4 derives for the file, and what
the reference provider answers. If the symbol list is empty, the language server
is the problem rather than this extension.

## Development

```bash
npm test                      # pure parsing logic, no VS Code required
npx @vscode/vsce package      # build the .vsix
```

`npm test` stubs the `vscode` module so the parsing, namespace resolution and
reference rewriting can be exercised in plain Node. Everything decidable from
text alone lives in pure functions and is covered there; the VS Code layer is
kept thin enough to read.

## Licence

MIT
