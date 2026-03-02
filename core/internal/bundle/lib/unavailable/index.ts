// export default new Proxy(
//     {},
//     {
//         get() {
//             throw "unavailable";
//         }
//     }
// );

export class Unavailable extends Error {
    constructor() {
        super("unavailable");
    }
}

export const Agent = Unavailable;

export default { Agent };
