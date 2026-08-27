import * as promises from "./promises.ts";
import {
    Interface,
    InterfaceConstructor,
    createInterface,
    emitKeypressEvents,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor
} from "./interface.ts";

export * from "./interface.ts";
export { promises };

export default {
    Interface,
    InterfaceConstructor,
    createInterface,
    emitKeypressEvents,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    promises
};
