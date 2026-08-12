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
    const named = text.match(/^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]/m);

    // An anonymous class opens a body mid-expression, so the line-anchored
    // match above never sees it and every trait `use` inside would be read as
    // an import. `new class` is unambiguous enough to cut on directly.
    const anonymous = text.match(/\bnew[ \t]+class\b/);

    const cuts = [named, anonymous].filter(Boolean).map((match) => match.index);

    return cuts.length > 0 ? text.slice(0, Math.min(...cuts)) : text;
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
 * Rewrite a fully qualified name against the file's own namespace.
 *
 * PHP resolves a qualified name that is not root-qualified against the current
 * namespace, so `Database\Seeders\Corporate\ProductSeeder` may be written as
 * `Corporate\ProductSeeder` inside `namespace Database\Seeders;` with no import
 * at all.
 *
 * Returns null for a class sitting directly in the namespace, whose bare name
 * already resolves, and null when the leading segment is an imported alias:
 * PHP checks imports before the current namespace, so the import would win and
 * the name would resolve somewhere else entirely.
 *
 * @param {string} fqn
 * @param {string|null} namespace The namespace the referencing file declares.
 * @param {Array<{fqn: string, alias: string}>} imports
 * @return {string|null}
 */
function namespaceRelative(fqn, namespace, imports) {
    if (!namespace || !fqn.startsWith(`${namespace}\\`)) {
        return null;
    }

    const remainder = fqn.slice(namespace.length + 1);

    if (!remainder.includes('\\')) {
        return null;
    }

    const head = remainder.slice(0, remainder.indexOf('\\'));

    return imports.some((entry) => entry.alias === head) ? null : remainder;
}

/**
 * The shortest spelling of a name the referencing file resolves correctly,
 * whether that comes from an import or from its own namespace.
 *
 * @param {string} fqn
 * @param {Array<{fqn: string, alias: string}>} imports
 * @param {string|null} namespace
 * @return {string|null}
 */
function shortestRelative(fqn, imports, namespace) {
    const candidates = [relativize(fqn, imports), namespaceRelative(fqn, namespace, imports)].filter(Boolean);

    return candidates.sort((left, right) => left.length - right.length)[0] ?? null;
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
 * @param {{separators?: string[], rootQualified?: boolean}} [options] `rootQualified`
 *   allows a leading `\`, which is right for a fully qualified name and wrong
 *   for one written relative to an import, where a leading `\` would name a
 *   different class in the root namespace.
 * @return {Array<{index: number, length: number, replacement: string}>} Sorted by offset.
 */
function fqnReplacements(text, oldFqn, newFqn, options = {}) {
    const { separators = ['\\', '\\\\'], rootQualified = true } = options;
    const edits = [];

    for (const separator of separators) {
        const from = oldFqn.split('\\').join(separator);
        const to = newFqn.split('\\').join(separator);
        const literal = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = separator.replace(/\\/g, '\\\\');
        const leading = rootQualified
            ? `(?<![A-Za-z0-9_])(?<![A-Za-z0-9_]${boundary})`
            : `(?<![A-Za-z0-9_])(?<!${boundary})`;
        const pattern = new RegExp(`${leading}${literal}(?![A-Za-z0-9_\\\\])`, 'g');

        let match;
        while ((match = pattern.exec(text)) !== null) {
            edits.push({ index: match.index, length: from.length, replacement: to });
        }
    }

    return edits.sort((left, right) => left.index - right.index);
}

/**
 * The qualified name surrounding a character offset, if there is one.
 *
 * The span runs over name characters and separators only, so it stops at the
 * `<` and `>` of a generic docblock tag, at `::`, and at any punctuation. A
 * leading `\` is part of the span so it is replaced along with the rest.
 * Names carrying no separator are rejected: they are already short.
 *
 * @param {string} text
 * @param {number} offset
 * @return {{fqn: string, index: number, length: number}|null} `fqn` has no leading separator.
 */
function qualifiedNameAt(text, offset) {
    const isNameCharacter = (character) => character !== undefined && /[A-Za-z0-9_\\]/.test(character);

    let start = Math.min(offset, text.length);
    let end = start;

    while (isNameCharacter(text[start - 1])) {
        start--;
    }

    while (isNameCharacter(text[end])) {
        end++;
    }

    const span = text.slice(start, end);

    if (!span.includes('\\') || span.endsWith('\\')) {
        return null;
    }

    const fqn = span.replace(/^\\+/, '');

    // A trailing segment is required; `App\` alone names nothing importable.
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)+$/.test(fqn)) {
        return null;
    }

    return { fqn, index: start, length: end - start };
}

/**
 * Every removable `use` statement, as whole-line spans.
 *
 * A statement is only reported when it occupies its own line, so `use A; use B;`
 * is left alone: the spans would overlap and removing one would take the other
 * with it. Group imports are skipped for the same reason — dropping one member
 * of `use A\{B, C};` means rewriting the statement, not deleting a line.
 *
 * @param {string} text
 * @return {Array<{start: number, end: number, fqn: string, alias: string}>}
 */
function importStatements(text) {
    const statement = /^[ \t]*use[ \t]+([^;(]+);[ \t]*\r?\n/gm;
    const region = importRegion(text);
    const found = [];

    let match;
    while ((match = statement.exec(region)) !== null) {
        const body = match[1].trim();

        if (body.includes('{') || /^(function|const)\b/.test(body)) {
            continue;
        }

        const parsed = collectImports(`<?php use ${body};`);

        if (parsed.length !== 1) {
            continue;
        }

        found.push({
            start: match.index,
            end: match.index + match[0].length,
            fqn: parsed[0].fqn,
            alias: parsed[0].alias,
        });
    }

    return found;
}

/**
 * The imports whose alias never appears anywhere else in the file.
 *
 * The search deliberately counts an alias inside a comment or a string as a
 * use. The two mistakes are not equal: keeping a redundant import is noise,
 * while dropping a needed one stops the file compiling, so anything that reads
 * like a mention keeps the import.
 *
 * @param {string} text
 * @return {Array<{start: number, end: number, fqn: string, alias: string}>}
 */
function unusedImports(text) {
    const statements = importStatements(text);

    // Blank the statements rather than cut them, so the remaining offsets and
    // therefore the reported spans stay valid.
    let body = text;

    for (const entry of statements) {
        body = body.slice(0, entry.start) + ' '.repeat(entry.end - entry.start) + body.slice(entry.end);
    }

    return statements.filter((entry) => {
        // A trailing separator is allowed: an alias is also used as the prefix
        // of a partially qualified name such as `Forms\Components\TextInput`.
        const usage = new RegExp(`(?<![A-Za-z0-9_$\\\\>:])${entry.alias}(?![A-Za-z0-9_])`);

        return !usage.test(body);
    });
}

/**
 * The unqualified class name surrounding a character offset, if there is one.
 *
 * A name touching a separator belongs to a qualified name and is left to
 * {@link qualifiedNameAt}. Variables, properties and static members are
 * excluded by what precedes them.
 *
 * The name must begin with an upper case letter. PSR-1 requires that of a
 * class, and it is what keeps keywords, scalar type names and locals from
 * raising an offer on nearly every identifier in the file.
 *
 * @param {string} text
 * @param {number} offset
 * @return {{name: string, index: number, length: number}|null}
 */
function bareNameAt(text, offset) {
    const isNameCharacter = (character) => character !== undefined && /[A-Za-z0-9_]/.test(character);

    let start = Math.min(offset, text.length);
    let end = start;

    while (isNameCharacter(text[start - 1])) {
        start--;
    }

    while (isNameCharacter(text[end])) {
        end++;
    }

    const name = text.slice(start, end);

    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
        return null;
    }

    if (text[start - 1] === '\\' || text[end] === '\\') {
        return null;
    }

    if (/(\$|->|\?->|::)$/.test(text.slice(Math.max(0, start - 3), start))) {
        return null;
    }

    return { name, index: start, length: end - start };
}

/**
 * Where to insert a `use` statement, and the text to insert there.
 *
 * The new import joins an existing block in alphabetical order. With no block
 * to join it goes after the namespace statement, or failing that after the
 * opening tag, separated by a blank line.
 *
 * @param {string} text
 * @param {string} fqn
 * @return {{index: number, text: string}}
 */
function importInsertion(text, fqn) {
    const statement = /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?([^;(]+);[ \t]*\r?\n/gm;
    const region = importRegion(text);
    const existing = [];

    let match;
    while ((match = statement.exec(region)) !== null) {
        existing.push({
            start: match.index,
            end: match.index + match[0].length,
            name: match[1].trim(),
        });
    }

    const line = `use ${fqn};\n`;

    if (existing.length > 0) {
        const successor = existing.find((entry) => entry.name > fqn);

        return { index: successor ? successor.start : existing[existing.length - 1].end, text: line };
    }

    const namespace = namespaceDeclaration(text);
    const anchor = namespace ? text.indexOf(';', namespace.index) : text.indexOf('<?php');

    if (anchor === -1) {
        return { index: 0, text: line };
    }

    const lineEnd = text.indexOf('\n', anchor);

    return { index: lineEnd === -1 ? text.length : lineEnd + 1, text: `\n${line}` };
}

/**
 * Every qualified name in a file that is a candidate for shortening.
 *
 * The `namespace` statement and the import block are excluded: their names are
 * declarations, not references. Names inside a double-quoted string are not
 * matched either, because the doubled separator PHP requires there does not fit
 * the pattern — which is correct, since a string cannot be shortened.
 *
 * @param {string} text
 * @return {Array<{fqn: string, index: number, length: number}>} In document order.
 */
function qualifiedNameOccurrences(text) {
    const excluded = [];
    const namespace = text.match(/^[ \t]*namespace[ \t]+[^;{]+/m);

    if (namespace) {
        excluded.push([namespace.index, namespace.index + namespace[0].length]);
    }

    const region = importRegion(text);
    const useStatement = /\buse\s+(?:function\s+|const\s+)?[^;(]+;/g;

    let statement;
    while ((statement = useStatement.exec(region)) !== null) {
        excluded.push([statement.index, statement.index + statement[0].length]);
    }

    const pattern = /\\?[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)+/g;
    const found = [];

    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (excluded.some(([start, end]) => match.index >= start && match.index < end)) {
            continue;
        }

        found.push({
            fqn: match[0].replace(/^\\+/, ''),
            index: match.index,
            length: match[0].length,
        });
    }

    return found;
}

/**
 * Plan the shortening of every qualified name in a file.
 *
 * Occurrences are processed in document order and each new import is taken into
 * account for the ones after it, so a second name whose short form is already
 * claimed is left fully qualified rather than quietly resolving elsewhere.
 *
 * Insertion anchors are computed against the original text. Because each new
 * import is anchored before the first existing import that sorts after it, and
 * lines sharing an anchor are sorted among themselves, the resulting block stays
 * in order without any offset arithmetic.
 *
 * @param {string} text
 * @return {{replacements: Array<{index: number, length: number, replacement: string}>,
 *           insertions: Array<{index: number, text: string}>,
 *           skipped: string[]}}
 */
function shortenAllPlan(text) {
    const imports = collectImports(text);
    const taken = new Set(imports.map((entry) => entry.alias));
    const declared = typeDeclaration(text);

    if (declared) {
        taken.add(declared);
    }

    const namespace = namespaceDeclaration(text)?.name ?? null;
    const replacements = [];
    const added = new Map();
    const skipped = new Set();

    for (const occurrence of qualifiedNameOccurrences(text)) {
        const direct = imports.find((entry) => entry.fqn === occurrence.fqn);

        if (direct) {
            replacements.push({ ...occurrence, replacement: direct.alias });
            continue;
        }

        const relative = shortestRelative(occurrence.fqn, imports, namespace);

        if (relative) {
            replacements.push({ ...occurrence, replacement: relative });
            continue;
        }

        const short = shortName(occurrence.fqn);

        if (taken.has(short)) {
            skipped.add(occurrence.fqn);
            continue;
        }

        taken.add(short);
        imports.push({ fqn: occurrence.fqn, alias: short });

        const anchor = importInsertion(text, occurrence.fqn);
        const lines = added.get(anchor.index) ?? [];

        lines.push(anchor.text);
        added.set(anchor.index, lines);

        replacements.push({ ...occurrence, replacement: short });
    }

    // When no import block exists the anchor text opens one with a leading blank
    // line. Several imports landing there must share that one blank line rather
    // than each contributing another.
    const insertions = [...added.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, lines]) => {
            const opensBlock = lines.some((line) => line.startsWith('\n'));
            const sorted = lines.map((line) => line.replace(/^\n/, '')).sort();

            return { index, text: (opensBlock ? '\n' : '') + sorted.join('') };
        });

    return { replacements, insertions, skipped: [...skipped] };
}

/**
 * The file name of a URI path, without its `.php` extension.
 *
 * @param {string} uriPath
 * @return {string}
 */
function fileBaseName(uriPath) {
    const name = uriPath.slice(uriPath.lastIndexOf('/') + 1);

    return name.endsWith('.php') ? name.slice(0, -'.php'.length) : name;
}

/**
 * Every place a bare class name appears as an identifier, with its replacement.
 *
 * Only ever applied to a file that resolves the name to the renamed class:
 * one that imports it unaliased, declares it, or shares its namespace. Even
 * there the name is skipped when it touches a quote, so a Filament block key
 * such as `'RichTextBlock'` is not rewritten along with the class.
 *
 * @param {string} text
 * @param {string} oldName
 * @param {string} newName
 * @return {Array<{index: number, length: number, replacement: string}>}
 */
function bareNameReplacements(text, oldName, newName) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_$\\\\>:'"])${oldName}(?![A-Za-z0-9_'"])`, 'g');
    const edits = [];

    let match;
    while ((match = pattern.exec(text)) !== null) {
        edits.push({ index: match.index, length: oldName.length, replacement: newName });
    }

    return edits;
}

/**
 * Whether a file resolves a bare class name to the given class.
 *
 * True when it imports the class without an alias, or declares its namespace —
 * PHP resolves an unqualified name against the current namespace. An aliased
 * import is deliberately excluded: its body refers to the alias, which the
 * rename must not touch.
 *
 * @param {string} text
 * @param {{oldFqn: string, oldName: string}} rename
 * @return {boolean}
 */
function resolvesBareName(text, rename) {
    const namespace = rename.oldFqn.slice(0, rename.oldFqn.lastIndexOf('\\'));

    if (namespaceDeclaration(text)?.name === namespace) {
        return true;
    }

    return collectImports(text).some(
        (entry) => entry.fqn === rename.oldFqn && entry.alias === rename.oldName,
    );
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
        const namespace = namespaceDeclaration(document.getText())?.name ?? null;

        if (imports.length === 0 && !namespace) {
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

            const relative = shortestRelative(fqn, imports, namespace);

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
 * Offers to shorten the qualified name under the cursor.
 *
 * Which offer applies depends on what the file already imports, so at most one
 * is ever shown: reuse a direct import, reuse an imported parent namespace, or
 * add an import. An import is not offered when the short name is already taken
 * by something else in the file, since that would silently change what the
 * existing name resolves to.
 *
 * @type {vscode.CodeActionProvider}
 */
const shortenProvider = {
    provideCodeActions(document, range, context, token) {
        if (!vscode.workspace.getConfiguration('phpNamespaceTools').get('enabled', true)) {
            return undefined;
        }

        const text = document.getText();
        const offset = document.offsetAt(range.start);
        const found = qualifiedNameAt(text, offset);

        if (!found) {
            return importActionsFor(document, text, offset, token);
        }

        const span = new vscode.Range(
            document.positionAt(found.index),
            document.positionAt(found.index + found.length),
        );

        const imports = collectImports(text);
        const direct = imports.find((entry) => entry.fqn === found.fqn);

        if (direct) {
            return [shortenAction(document, span, direct.alias, `Use imported \`${direct.alias}\``)];
        }

        const relative = shortestRelative(found.fqn, imports, namespaceDeclaration(text)?.name ?? null);

        if (relative) {
            return [shortenAction(document, span, relative, `Shorten to \`${relative}\``)];
        }

        const short = shortName(found.fqn);

        if (imports.some((entry) => entry.alias === short) || typeDeclaration(text) === short) {
            return undefined;
        }

        const insertion = importInsertion(text, found.fqn);
        const action = shortenAction(document, span, short, `Import \`${found.fqn}\``);

        action.edit.insert(document.uri, document.positionAt(insertion.index), insertion.text);

        return [action];
    },
};

/**
 * Shorten every qualified name in the active PHP file at once.
 *
 * @param {vscode.OutputChannel} output
 */
async function shortenAll(output) {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== 'php') {
        vscode.window.showInformationMessage('Open a PHP file first.');

        return;
    }

    const { document } = editor;
    const plan = shortenAllPlan(document.getText());

    if (plan.replacements.length === 0) {
        vscode.window.showInformationMessage('No qualified name to shorten.');

        return;
    }

    const edit = new vscode.WorkspaceEdit();

    for (const replacement of plan.replacements) {
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(replacement.index),
                document.positionAt(replacement.index + replacement.length),
            ),
            replacement.replacement,
        );
    }

    for (const insertion of plan.insertions) {
        edit.insert(document.uri, document.positionAt(insertion.index), insertion.text);
    }

    await vscode.workspace.applyEdit(edit);

    const imported = plan.insertions.reduce((total, entry) => total + entry.text.trimStart().split('\n').length - 1, 0);

    vscode.window.showInformationMessage(
        `Shortened ${plan.replacements.length} name(s), added ${imported} import(s).` +
            (plan.skipped.length > 0 ? ` ${plan.skipped.length} left qualified.` : ''),
    );

    if (plan.skipped.length > 0) {
        output.appendLine('left fully qualified, their short name is taken in this file:');
        for (const fqn of plan.skipped) {
            output.appendLine(`  ${fqn}`);
        }
        output.show(true);
    }
}

/**
 * Offers an import for an unqualified class name the file does not resolve.
 *
 * Candidates come from the workspace symbol index, so one offer is made per
 * class that carries the name. A class already imported, declared in this file,
 * or living in this file's own namespace needs no import and is passed over.
 *
 * @param {vscode.TextDocument} document
 * @param {string} text
 * @param {number} offset
 * @param {vscode.CancellationToken} token
 * @return {Promise<vscode.CodeAction[]|undefined>}
 */
async function importActionsFor(document, text, offset, token) {
    const found = bareNameAt(text, offset);

    if (!found) {
        return undefined;
    }

    const imports = collectImports(text);

    if (imports.some((entry) => entry.alias === found.name) || typeDeclaration(text) === found.name) {
        return undefined;
    }

    const symbols = await vscode.commands.executeCommand(
        'vscode.executeWorkspaceSymbolProvider',
        found.name,
    );

    if (token.isCancellationRequested || !Array.isArray(symbols)) {
        return undefined;
    }

    const namespace = namespaceDeclaration(text)?.name ?? '';
    const span = new vscode.Range(
        document.positionAt(found.index),
        document.positionAt(found.index + found.length),
    );

    const candidates = [];

    for (const symbol of symbols) {
        if (!TYPE_KINDS.has(symbol.kind)) {
            continue;
        }

        const fqn = fullyQualifiedName(symbol);

        if (shortName(fqn) !== found.name || candidates.includes(fqn)) {
            continue;
        }

        // A class in this file's own namespace already resolves unqualified.
        if (fqn === `${namespace}\\${found.name}`) {
            return undefined;
        }

        candidates.push(fqn);
    }

    return candidates.sort().map((fqn) => {
        // Reuse an imported parent namespace, or the file's own namespace,
        // rather than adding an import.
        const relative = shortestRelative(fqn, imports, namespace || null);

        if (relative) {
            return shortenAction(document, span, relative, `Use \`${relative}\``);
        }

        const insertion = importInsertion(text, fqn);
        const action = shortenAction(document, span, found.name, `Import \`${fqn}\``);

        action.edit.insert(document.uri, document.positionAt(insertion.index), insertion.text);

        return action;
    });
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Range} span
 * @param {string} replacement
 * @param {string} title
 * @return {vscode.CodeAction}
 */
function shortenAction(document, span, replacement, title) {
    const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, span, replacement);

    return action;
}

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

        if (!declaration) {
            continue;
        }

        const type = typeDeclaration(text);
        const oldBase = fileBaseName(oldUri.path);
        const newBase = fileBaseName(newUri.path);

        // The type is only renamed when it was named after its file, which is
        // what PSR-4 requires. A file holding a differently named class is
        // being moved, not renamed.
        const renamedType = type === oldBase && newBase !== oldBase ? newBase : type;
        const movedNamespace = declaration.name !== target;

        if (!movedNamespace && renamedType === type) {
            continue;
        }

        if (movedNamespace) {
            replaceOffset(edit, oldUri, text, declaration.index, declaration.name.length, target);
            output.appendLine(`${vscode.workspace.asRelativePath(oldUri, false)}: ${declaration.name} -> ${target}`);
        }

        if (!type) {
            continue;
        }

        if (renamedType !== type) {
            output.appendLine(`${vscode.workspace.asRelativePath(oldUri, false)}: class ${type} -> ${renamedType}`);
        }

        renames.push({
            oldFqn: `${declaration.name}\\${type}`,
            newFqn: `${target}\\${renamedType}`,
            oldName: type,
            newName: renamedType,
        });
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
    // than a regex per rename. The short name is the one thing every spelling
    // of a reference contains — fully qualified, partially qualified against an
    // imported namespace, or bare — so rejecting on it cannot lose a match.
    const needles = [...new Set(renames.map(({ oldName }) => oldName))];

    const candidates = await vscode.workspace.findFiles('**/*.php', '**/{vendor,node_modules}/**');
    let files = 0;
    let references = 0;

    for (const uri of candidates) {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

        if (!needles.some((needle) => text.includes(needle))) {
            continue;
        }

        const imports = collectImports(text);
        const namespace = namespaceDeclaration(text)?.name ?? null;
        let found = 0;

        const apply = (occurrences) => {
            for (const occurrence of occurrences) {
                replaceOffset(edit, uri, text, occurrence.index, occurrence.length, occurrence.replacement);
                found++;
            }
        };

        for (const rename of renames) {
            apply(fqnReplacements(text, rename.oldFqn, rename.newFqn));

            // A name written against an imported parent namespace, such as
            // `PageBlocks\About\CompanyInfoBlock` under `use App\Filament\PageBlocks;`,
            // or against the file's own namespace, such as `Corporate\ProductSeeder`
            // inside `namespace Database\Seeders;`. Neither the fully qualified
            // nor the bare pass can see either spelling.
            const oldRelative = shortestRelative(rename.oldFqn, imports, namespace);

            if (oldRelative) {
                // Once moved out from under that import or namespace there is no
                // relative spelling left, so fall back to a root-qualified name —
                // an unqualified one would resolve against the current namespace.
                const newRelative = shortestRelative(rename.newFqn, imports, namespace) ?? `\\${rename.newFqn}`;

                if (newRelative !== oldRelative) {
                    apply(
                        fqnReplacements(text, oldRelative, newRelative, {
                            separators: ['\\'],
                            rootQualified: false,
                        }),
                    );
                }
            }

            // A renamed class also has to be repointed where the file refers to
            // it by its bare name, which neither pass above can see.
            if (rename.oldName === rename.newName || !resolvesBareName(text, rename)) {
                continue;
            }

            apply(bareNameReplacements(text, rename.oldName, rename.newName));
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

/**
 * Delete the import statements the active file never refers to.
 *
 * @param {vscode.OutputChannel} output
 */
async function removeUnusedImports(output) {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== 'php') {
        return;
    }

    const text = editor.document.getText();
    const dead = unusedImports(text);

    if (dead.length === 0) {
        vscode.window.showInformationMessage('PHP Namespace Tools: no unused imports.');

        return;
    }

    await editor.edit((builder) => {
        // Back to front, so an earlier span keeps its offsets.
        for (const entry of [...dead].reverse()) {
            builder.delete(
                new vscode.Range(editor.document.positionAt(entry.start), editor.document.positionAt(entry.end)),
            );
        }
    });

    for (const entry of dead) {
        output.appendLine(`${vscode.workspace.asRelativePath(editor.document.uri, false)}: removed ${entry.fqn}`);
    }

    vscode.window.showInformationMessage(
        `PHP Namespace Tools: removed ${dead.length} unused import${dead.length === 1 ? '' : 's'}.`,
    );
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const output = vscode.window.createOutputChannel('PHP Namespace Tools');

    context.subscriptions.push(
        output,
        vscode.languages.registerCompletionItemProvider({ language: 'php', scheme: 'file' }, provider),
        vscode.languages.registerCodeActionsProvider({ language: 'php', scheme: 'file' }, shortenProvider, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
        }),
        vscode.commands.registerCommand('phpNamespaceTools.debugSymbols', () => debugSymbols(output)),
        vscode.commands.registerCommand('phpNamespaceTools.removeUnusedImports', () => removeUnusedImports(output)),
        vscode.commands.registerCommand('phpNamespaceTools.shortenAll', () => shortenAll(output)),
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
    bareNameReplacements,
    resolvesBareName,
    fileBaseName,
    qualifiedNameAt,
    bareNameAt,
    importStatements,
    unusedImports,
    namespaceRelative,
    shortestRelative,
    importInsertion,
    qualifiedNameOccurrences,
    shortenAllPlan,
    offsetToPosition,
};
