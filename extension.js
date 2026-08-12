const vscode = require('vscode');

/** Symbol kinds that can legally appear as a type reference in PHP source. */
const TYPE_KINDS = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Object,
]);

/**
 * Everything before the first type declaration, which is the only region where
 * import statements may legally appear.
 *
 * Slicing here is what keeps `use SomeTrait;` inside a class body and the
 * closure `use ($captured)` form out of the import list.
 *
 * @param {string} text
 * @return {string}
 */
function importRegion(text) {
    const declaration = text.match(/^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]/m);

    return declaration ? text.slice(0, declaration.index) : text;
}

/**
 * Parse every `use` statement in a document into {fqn, alias} pairs.
 *
 * Handles plain imports, aliased imports and PHP 7 group imports. `use function`
 * and `use const` are skipped: they live in a separate resolution space and are
 * never valid as a type prefix.
 *
 * @param {string} text
 * @return {Array<{fqn: string, alias: string}>}
 */
function collectImports(text) {
    const imports = [];

    // Not line-anchored: `<?php use A;` and `use A; use B;` are both legal. The
    // body excludes `(` so a closure `use (...)` can never start a match.
    const statement = /\buse\s+(function\s+|const\s+)?([^;(]+);/g;

    const region = importRegion(text);

    let match;
    while ((match = statement.exec(region)) !== null) {
        if (match[1]) {
            continue;
        }

        const body = match[2].trim();
        const group = body.match(/^(.+?)\\\{(.+)\}$/s);

        if (group) {
            for (const member of group[2].split(',')) {
                addImport(imports, `${group[1]}\\${member.trim()}`);
            }
            continue;
        }

        addImport(imports, body);
    }

    return imports;
}

/**
 * @param {Array<{fqn: string, alias: string}>} imports
 * @param {string} declaration
 */
function addImport(imports, declaration) {
    const aliased = declaration.match(/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    const fqn = (aliased ? aliased[1] : declaration).trim().replace(/^\\/, '');

    if (!fqn || fqn.includes('{')) {
        return;
    }

    imports.push({
        fqn,
        alias: aliased ? aliased[2] : fqn.split('\\').pop(),
    });
}

/**
 * Rewrite a fully qualified name against the longest matching import prefix.
 *
 * Returns null when no import covers the name, or when the name is already
 * imported directly and the short form therefore works as-is.
 *
 * @param {string} fqn
 * @param {Array<{fqn: string, alias: string}>} imports
 * @return {string|null}
 */
function relativize(fqn, imports) {
    let longest = null;

    for (const candidate of imports) {
        if (fqn === candidate.fqn) {
            return null;
        }

        if (!fqn.startsWith(`${candidate.fqn}\\`)) {
            continue;
        }

        if (!longest || candidate.fqn.length > longest.fqn.length) {
            longest = candidate;
        }
    }

    if (!longest) {
        return null;
    }

    return `${longest.alias}\\${fqn.slice(longest.fqn.length + 1)}`;
}

/**
 * Resolve the namespace a file must declare, from a composer PSR-4 map.
 *
 * The longest matching directory prefix wins, so a more specific mapping such
 * as `App\Domain\ => app/Domain/` beats `App\ => app/`.
 *
 * @param {string} relativePath Workspace-relative path with forward slashes, e.g. `app/Models/User.php`.
 * @param {Object<string, string|string[]>} psr4 The `autoload.psr-4` object from composer.json.
 * @return {string|null} Namespace without a trailing separator, or null when unmapped.
 */
function psr4NamespaceFor(relativePath, psr4) {
    const directory = relativePath.includes('/') ? relativePath.replace(/\/[^/]*$/, '') : '';
    let best = null;

    for (const [prefix, roots] of Object.entries(psr4 || {})) {
        for (const root of Array.isArray(roots) ? roots : [roots]) {
            const base = String(root).replace(/^\.\//, '').replace(/\/+$/, '');

            // An empty root maps the project root itself and matches every file.
            if (base !== '' && directory !== base && !directory.startsWith(`${base}/`)) {
                continue;
            }

            if (best && base.length <= best.base.length) {
                continue;
            }

            best = { base, prefix };
        }
    }

    if (!best) {
        return null;
    }

    const remainder = best.base === '' ? directory : directory.slice(best.base.length).replace(/^\//, '');
    const namespace = best.prefix.replace(/\\+$/, '');
    const suffix = remainder ? remainder.split('/').join('\\') : '';

    return suffix ? `${namespace}\\${suffix}` : namespace;
}

/**
 * Locate the namespace name in a `namespace X;` or `namespace X { }` statement.
 *
 * The keyword is captured separately rather than searched for inside the match,
 * because a namespace may legitimately be called `space` and `indexOf` would
 * then find it inside the keyword itself.
 *
 * @param {string} text
 * @return {{name: string, index: number}|null} Offset of the name within `text`.
 */
function namespaceDeclaration(text) {
    const match = text.match(/^([ \t]*namespace[ \t]+)([A-Za-z_][A-Za-z0-9_\\]*)/m);

    if (!match) {
        return null;
    }

    return { name: match[2], index: match.index + match[1].length };
}

/**
 * Locate the first type declared in a file.
 *
 * @param {string} text
 * @return {string|null}
 */
function typeDeclaration(text) {
    const match = text.match(
        /^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m,
    );

    return match ? match[1] : null;
}

/**
 * Every place a fully qualified name appears in a file, with its replacement.
 *
 * Both spellings are searched: the single backslash form of source code and
 * `use` statements, and the doubled form a double-quoted PHP string requires,
 * which is how class names are written in Laravel config files.
 *
 * The boundaries are what keep this safe. A match must not continue into a
 * longer name (`App\Models\Users`), must not be the tail of a different one
 * (`Vendor\App\Models\User`), and must not be a parent of a deeper one
 * (`App\Models\User\Profile`) — while a root-qualified `\App\Models\User` must
 * still match.
 *
 * @param {string} text
 * @param {string} oldFqn
 * @param {string} newFqn
 * @return {Array<{index: number, length: number, replacement: string}>} Sorted by offset.
 */
function fqnReplacements(text, oldFqn, newFqn) {
    const edits = [];

    for (const separator of ['\\', '\\\\']) {
        const from = oldFqn.split('\\').join(separator);
        const to = newFqn.split('\\').join(separator);
        const literal = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = separator.replace(/\\/g, '\\\\');
        const pattern = new RegExp(
            `(?<![A-Za-z0-9_])(?<![A-Za-z0-9_]${boundary})${literal}(?![A-Za-z0-9_\\\\])`,
            'g',
        );

        let match;
        while ((match = pattern.exec(text)) !== null) {
            edits.push({ index: match.index, length: from.length, replacement: to });
        }
    }

    return edits.sort((left, right) => left.index - right.index);
}

/**
 * Convert a character offset into a zero-based line and character pair.
 *
 * Used to place an edit without opening the file as a text document, which
 * matters when a directory move touches hundreds of files at once.
 *
 * @param {string} text
 * @param {number} offset
 * @return {{line: number, character: number}}
 */
function offsetToPosition(text, offset) {
    let line = 0;
    let lineStart = 0;

    for (let index = 0; index < offset; index++) {
        if (text[index] === '\n') {
            line++;
            lineStart = index + 1;
        }
    }

    return { line, character: offset - lineStart };
}

/**
 * Build the fully qualified name of a workspace symbol.
 *
 * @param {vscode.SymbolInformation} symbol
 * @return {string}
 */
function fullyQualifiedName(symbol) {
    const container = (symbol.containerName || '').replace(/^\\+|\\+$/g, '');
    const name = symbol.name.replace(/^\\+/, '');

    // DEVSENSE PHP Tools returns classes with the namespace already inside
    // `name` and `containerName` empty, but repeats the namespace in both for
    // constants and methods, separated by `::` rather than `\`. Joining
    // unconditionally would duplicate it either way.
    const remainder = name.startsWith(container) ? name.slice(container.length) : null;

    if (!container || remainder === '' || remainder?.startsWith('\\') || remainder?.startsWith('::')) {
        return name;
    }

    return `${container}\\${name}`;
}

/**
 * The trailing segment of a fully qualified name.
 *
 * @param {string} fqn
 * @return {string}
 */
function shortName(fqn) {
    return fqn.split('\\').pop();
}

/**
 * Extract the bare identifier being typed, or null when the position is not a
 * place where an unqualified type name may start.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @return {string|null}
 */
function typedIdentifier(document, position) {
    const before = document.lineAt(position).text.slice(0, position.character);
    const word = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);

    if (!word) {
        return null;
    }

    const preceding = before.slice(0, before.length - word[1].length);

    // Already namespace-qualified, a member access, or a variable: the language
    // server resolves these correctly on its own.
    if (/(\\|->|\?->|::|\$)$/.test(preceding)) {
        return null;
    }

    // Inside a use statement the whole point is the fully qualified form.
    if (/^[ \t]*use[ \t]/.test(before)) {
        return null;
    }

    return word[1];
}

/** @type {vscode.CompletionItemProvider} */
const provider = {
    async provideCompletionItems(document, position, token) {
        const config = vscode.workspace.getConfiguration('phpNamespaceTools');

        if (!config.get('enabled', true)) {
            return undefined;
        }

        const word = typedIdentifier(document, position);

        if (!word || word.length < config.get('minimumPrefixLength', 3)) {
            return undefined;
        }

        const imports = collectImports(document.getText());

        if (imports.length === 0) {
            return undefined;
        }

        const symbols = await vscode.commands.executeCommand(
            'vscode.executeWorkspaceSymbolProvider',
            word,
        );

        if (token.isCancellationRequested || !Array.isArray(symbols)) {
            return undefined;
        }

        const replace = new vscode.Range(position.translate(0, -word.length), position);
        const limit = config.get('maximumSuggestions', 25);
        const seen = new Set();
        const items = [];

        for (const symbol of symbols) {
            if (items.length >= limit) {
                break;
            }

            if (!TYPE_KINDS.has(symbol.kind)) {
                continue;
            }

            const fqn = fullyQualifiedName(symbol);
            const short = shortName(fqn);

            // The symbol provider matches fuzzily across the whole project, so a
            // query for `TextInput` also returns `TestTriggeredPhpunitNotice`.
            if (!short.toLowerCase().includes(word.toLowerCase())) {
                continue;
            }

            const relative = relativize(fqn, imports);

            if (!relative || seen.has(relative)) {
                continue;
            }

            seen.add(relative);

            const item = new vscode.CompletionItem(short, vscode.CompletionItemKind.Class);
            item.detail = relative;
            item.documentation = new vscode.MarkdownString(`\`${fqn}\`\n\nInserts \`${relative}\` — no new \`use\` statement.`);
            item.insertText = relative;
            item.filterText = short;
            item.range = replace;
            item.sortText = `0${short}`;
            item.preselect = items.length === 0;

            items.push(item);
        }

        // Marked incomplete so VS Code re-queries the symbol provider on every
        // keystroke. Otherwise it caches this list and filters it locally, and a
        // longer prefix never reaches the language server.
        return new vscode.CompletionList(items, true);
    },
};

/**
 * Dump raw workspace symbol results so the underlying language server's output
 * can be inspected. This is the assumption the whole extension rests on.
 *
 * @param {vscode.OutputChannel} output
 */
async function debugSymbols(output) {
    const query = await vscode.window.showInputBox({
        prompt: 'Workspace symbol query',
        placeHolder: 'TextInput',
    });

    if (!query) {
        return;
    }

    const symbols = await vscode.commands.executeCommand(
        'vscode.executeWorkspaceSymbolProvider',
        query,
    );

    output.clear();
    output.appendLine(`query: ${query}`);
    output.appendLine(`results: ${Array.isArray(symbols) ? symbols.length : 'none'}`);
    output.appendLine('');

    for (const symbol of (symbols || []).slice(0, 60)) {
        output.appendLine(
            [
                fullyQualifiedName(symbol).padEnd(70),
                `kind=${vscode.SymbolKind[symbol.kind]}`.padEnd(18),
                `container=${JSON.stringify(symbol.containerName)}`,
            ].join(' '),
        );
    }

    const editor = vscode.window.activeTextEditor;

    if (editor && editor.document.languageId === 'php') {
        output.appendLine('');
        output.appendLine('imports in active document:');
        for (const entry of collectImports(editor.document.getText())) {
            output.appendLine(`  ${entry.alias.padEnd(24)} -> ${entry.fqn}`);
        }

        await probeRenameFoundations(output, editor);
    }

    output.show(true);
}

/**
 * Probe the two capabilities a rename/move refactoring would be built on: the
 * reference provider, and a readable composer PSR-4 map.
 *
 * @param {vscode.OutputChannel} output
 * @param {vscode.TextEditor} editor
 */
async function probeRenameFoundations(output, editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

    output.appendLine('');
    output.appendLine('--- rename/move foundations ---');

    if (!folder) {
        output.appendLine('no workspace folder for the active document');
        return;
    }

    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);

    try {
        const composerUri = vscode.Uri.joinPath(folder.uri, 'composer.json');
        const raw = await vscode.workspace.fs.readFile(composerUri);
        const composer = JSON.parse(Buffer.from(raw).toString('utf8'));
        const psr4 = (composer.autoload || {})['psr-4'] || {};

        output.appendLine(`composer psr-4: ${JSON.stringify(psr4)}`);
        output.appendLine(`path:           ${relative}`);
        output.appendLine(`derived ns:     ${psr4NamespaceFor(relative, psr4)}`);

        const declared = editor.document.getText().match(/^[ \t]*namespace[ \t]+([^;]+);/m);
        output.appendLine(`declared ns:    ${declared ? declared[1].trim() : '(none)'}`);
    } catch (error) {
        output.appendLine(`composer.json unreadable: ${error.message}`);
    }

    const references = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        editor.document.uri,
        editor.selection.active,
    );

    output.appendLine(
        `reference provider at cursor: ${Array.isArray(references) ? `${references.length} hit(s)` : 'no provider'}`,
    );

    for (const reference of (references || []).slice(0, 10)) {
        output.appendLine(
            `  ${vscode.workspace.asRelativePath(reference.uri, false)}:${reference.range.start.line + 1}`,
        );
    }
}

/**
 * Read the merged PSR-4 map of a workspace folder.
 *
 * `autoload` is applied over `autoload-dev` so a prefix declared in both wins
 * from the non-dev section, matching how composer builds its classmap.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @return {Promise<Object<string, string|string[]>|null>}
 */
async function readPsr4(folder) {
    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'composer.json'));
        const composer = JSON.parse(Buffer.from(raw).toString('utf8'));

        return {
            ...((composer['autoload-dev'] || {})['psr-4'] || {}),
            ...((composer.autoload || {})['psr-4'] || {}),
        };
    } catch {
        return null;
    }
}

/** Directories never worth descending into when a folder is moved. */
const SKIPPED_DIRECTORIES = new Set(['vendor', 'node_modules']);

/**
 * Every `.php` file at or below a URI, as {@link vscode.Uri} values.
 *
 * The directory tree is walked directly rather than through `findFiles`, whose
 * results are filtered by the user's search excludes — a file silently skipped
 * here would keep a namespace that no longer autoloads.
 *
 * @param {vscode.Uri} uri
 * @return {Promise<vscode.Uri[]>}
 */
async function phpFilesUnder(uri) {
    let entries;

    try {
        entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return uri.path.endsWith('.php') ? [uri] : [];
    }

    const found = [];

    for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(uri, name);

        if (type === vscode.FileType.Directory) {
            if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) {
                continue;
            }

            found.push(...(await phpFilesUnder(child)));
        } else if (name.endsWith('.php')) {
            found.push(child);
        }
    }

    return found;
}

/**
 * Expand one reported rename into the individual PHP files it moves.
 *
 * VS Code reports a directory move as a single rename of the directory, so the
 * children have to be enumerated to be renamespaced.
 *
 * @param {vscode.Uri} oldUri
 * @param {vscode.Uri} newUri
 * @return {Promise<Array<{oldUri: vscode.Uri, newUri: vscode.Uri}>>}
 */
async function expandMove(oldUri, newUri) {
    const files = await phpFilesUnder(oldUri);

    return files.map((file) => ({
        oldUri: file,
        newUri: newUri.with({ path: newUri.path + file.path.slice(oldUri.path.length) }),
    }));
}

/**
 * Rewrite the `namespace` declaration of each PHP file being moved so it keeps
 * matching its PSR-4 directory.
 *
 * The edits target the old locations: VS Code applies them before performing the
 * rename. Only the moved files themselves are touched — imports of them elsewhere
 * in the project are left alone, and the language server reports them as
 * unresolved.
 *
 * @param {ReadonlyArray<{oldUri: vscode.Uri, newUri: vscode.Uri}>} files
 * @param {vscode.OutputChannel} output
 * @return {Promise<vscode.WorkspaceEdit>}
 */
async function namespaceUpdatesForMove(files, output) {
    const edit = new vscode.WorkspaceEdit();
    const moves = [];

    for (const { oldUri, newUri } of files) {
        moves.push(...(await expandMove(oldUri, newUri)));
    }

    const configuration = vscode.workspace.getConfiguration('phpNamespaceTools');
    const limit = configuration.get('maximumFilesPerMove', 500);

    if (moves.length > limit) {
        output.appendLine(
            `move touches ${moves.length} PHP files, above the ${limit} file limit — nothing was updated`,
        );
        output.show(true);

        return edit;
    }

    const renames = [];

    for (const { oldUri, newUri } of moves) {
        const folder = vscode.workspace.getWorkspaceFolder(newUri) ?? vscode.workspace.getWorkspaceFolder(oldUri);

        if (!folder) {
            continue;
        }

        const psr4 = await readPsr4(folder);
        const target = psr4 && psr4NamespaceFor(vscode.workspace.asRelativePath(newUri, false), psr4);

        if (!target) {
            continue;
        }

        const text = Buffer.from(await vscode.workspace.fs.readFile(oldUri)).toString('utf8');
        const declaration = namespaceDeclaration(text);

        if (!declaration || declaration.name === target) {
            continue;
        }

        replaceOffset(edit, oldUri, text, declaration.index, declaration.name.length, target);
        output.appendLine(`${vscode.workspace.asRelativePath(oldUri, false)}: ${declaration.name} -> ${target}`);

        const type = typeDeclaration(text);

        if (type) {
            renames.push({
                oldFqn: `${declaration.name}\\${type}`,
                newFqn: `${target}\\${type}`,
            });
        }
    }

    if (renames.length > 0 && configuration.get('updateImportsOnMove', true)) {
        await updateReferences(edit, renames, output);
    }

    return edit;
}

/**
 * Queue a replacement described by a character offset into `text`.
 *
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.Uri} uri
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @param {string} replacement
 */
function replaceOffset(edit, uri, text, index, length, replacement) {
    const start = offsetToPosition(text, index);
    const end = offsetToPosition(text, index + length);

    edit.replace(
        uri,
        new vscode.Range(
            new vscode.Position(start.line, start.character),
            new vscode.Position(end.line, end.character),
        ),
        replacement,
    );
}

/**
 * Repoint every reference to a moved class at its new fully qualified name.
 *
 * Matching is textual on the full name rather than driven by the reference
 * provider, which covers `use` statements, `::class` expressions and the plain
 * strings Laravel configuration uses to name classes — the last of which no
 * PHP language server resolves.
 *
 * Candidate files come from `findFiles`, so a path hidden by the user's
 * `files.exclude` or `search.exclude` is not visited.
 *
 * @param {vscode.WorkspaceEdit} edit
 * @param {Array<{oldFqn: string, newFqn: string}>} renames
 * @param {vscode.OutputChannel} output
 */
async function updateReferences(edit, renames, output) {
    // Cheap pre-filter so most files are rejected on a substring test rather
    // than a regex per rename. Both separator spellings have to be looked for,
    // since a doubled one does not contain the single one as a substring.
    const needles = [
        ...new Set(
            renames.flatMap(({ oldFqn }) => {
                const namespace = oldFqn.slice(0, oldFqn.lastIndexOf('\\'));

                return [namespace, namespace.split('\\').join('\\\\')];
            }),
        ),
    ];

    const candidates = await vscode.workspace.findFiles('**/*.php', '**/{vendor,node_modules}/**');
    let files = 0;
    let references = 0;

    for (const uri of candidates) {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

        if (!needles.some((needle) => text.includes(needle))) {
            continue;
        }

        let found = 0;

        for (const { oldFqn, newFqn } of renames) {
            for (const occurrence of fqnReplacements(text, oldFqn, newFqn)) {
                replaceOffset(edit, uri, text, occurrence.index, occurrence.length, occurrence.replacement);
                found++;
            }
        }

        if (found > 0) {
            files++;
            references += found;
            output.appendLine(`  ${vscode.workspace.asRelativePath(uri, false)}: ${found} reference(s)`);
        }
    }

    output.appendLine(`repointed ${references} reference(s) across ${files} file(s)`);
    output.show(true);
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const output = vscode.window.createOutputChannel('PHP Namespace Tools');

    context.subscriptions.push(
        output,
        vscode.languages.registerCompletionItemProvider({ language: 'php', scheme: 'file' }, provider),
        vscode.commands.registerCommand('phpNamespaceTools.debugSymbols', () => debugSymbols(output)),
        vscode.workspace.onWillRenameFiles((event) => {
            if (vscode.workspace.getConfiguration('phpNamespaceTools').get('updateNamespaceOnMove', true)) {
                event.waitUntil(namespaceUpdatesForMove(event.files, output));
            }
        }),
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    collectImports,
    relativize,
    fullyQualifiedName,
    shortName,
    importRegion,
    psr4NamespaceFor,
    namespaceDeclaration,
    typeDeclaration,
    fqnReplacements,
    offsetToPosition,
};
