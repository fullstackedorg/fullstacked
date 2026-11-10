// One bridge per page (and per worker, which has its own global scope).
// Every bundle starts with `import "fullstacked"` and carries its own copy
// of the lib, and a page can import() more bundles. The first copy installs
// the bridge on globalThis.fullstacked.__bridge: the platform bridge, the
// call ids, the responses put on the frame stream and the streams. A later
// copy uses those instead of its own, so the calls of every bundle share the
// ids and the frames reach the duplex that waits for them, whichever bundle
// opened it.
//
// The parts are the first copy's functions, shared with every copy built
// with the same BRIDGE_VERSION. Bump it when a part changes shape or one of
// its functions changes signature: a bundle built with another version
// throws when it loads (its import() rejects) instead of mixing up the
// calls of the page.

export const BRIDGE_VERSION = 1;

export type SharedBridge = {
    version: number;
    parts: Record<string, unknown>;
};

function versionMismatch(version: number | null) {
    const running =
        version === null
            ? "an older one, without a shared bridge"
            : `version ${version}`;
    return new Error(
        `This bundle uses the FullStacked bridge version ${BRIDGE_VERSION}, ` +
            `the page runs ${running}. Bundle the code loaded in one page ` +
            `with the same version of FullStacked.`
    );
}

function sharedBridge(): SharedBridge {
    globalThis.fullstacked = globalThis.fullstacked || {};
    const fullstacked = globalThis.fullstacked;
    const existing = fullstacked.__bridge;
    if (existing) {
        if (existing.version !== BRIDGE_VERSION) {
            throw versionMismatch(existing.version);
        }
        return existing;
    }
    // a lib from before the shared bridge installed its own
    if (fullstacked.bridge) {
        throw versionMismatch(null);
    }
    const bridge: SharedBridge = { version: BRIDGE_VERSION, parts: {} };
    Object.defineProperty(fullstacked, "__bridge", {
        value: bridge,
        enumerable: false
    });
    return bridge;
}

// fails at once, before the lib of this bundle touches the page
sharedBridge();

// The part of the page's bridge, created by the first copy that needs it
export function shared<T>(name: string, create: () => T): T {
    const { parts } = sharedBridge();
    if (!(name in parts)) {
        parts[name] = create();
    }
    return parts[name] as T;
}
