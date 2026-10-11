// Bundled dependencies use Object.hasOwn (Node 16.9+). Keep the packaged Node 14
// host contract without changing the extension host's global Object built-in.
export function bundledHasOwn(object: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(object, key);
}
