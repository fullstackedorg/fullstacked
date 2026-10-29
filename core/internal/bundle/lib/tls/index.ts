export class Unavailable extends Error {
    constructor() {
        super("unavailable");
    }
}

export const Server = Unavailable;
export const TLSSocket = Unavailable;

export function connect(): never {
    throw new Unavailable();
}

export function createServer(): never {
    throw new Unavailable();
}

export function createSecureContext(): never {
    throw new Unavailable();
}

export function checkServerIdentity(): never {
    throw new Unavailable();
}

export function getCiphers(): never {
    throw new Unavailable();
}

export const rootCertificates: string[] = [];

export const DEFAULT_ECDH_CURVE = "auto";
export const DEFAULT_MAX_VERSION = "TLSv1.3";
export const DEFAULT_MIN_VERSION = "TLSv1.2";
export const DEFAULT_CIPHERS = "";

export default {
    Server,
    TLSSocket,
    connect,
    createServer,
    createSecureContext,
    checkServerIdentity,
    getCiphers,
    rootCertificates,
    DEFAULT_ECDH_CURVE,
    DEFAULT_MAX_VERSION,
    DEFAULT_MIN_VERSION,
    DEFAULT_CIPHERS
};
