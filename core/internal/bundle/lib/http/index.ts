export class Unavailable extends Error {
    constructor() {
        super("unavailable");
    }
}

export const Agent = Unavailable;

export default { Agent };
