// util.parseArgs (Node 22): the arguments become tokens first (short groups
// expanded, `--` ends the options), then values, with Node's errors in
// strict mode.

import {
    hasOwn,
    invalidArgType,
    invalidArgValue,
    nodeError,
    validateString
} from "./internal.ts";

type OptionConfig = {
    type: "string" | "boolean";
    short?: string;
    multiple?: boolean;
    default?: unknown;
};

type ParseArgsConfig = {
    args?: string[];
    options?: Record<string, OptionConfig>;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
};

type Token = {
    kind: "option" | "positional" | "option-terminator";
    index: number;
    name?: string;
    rawName?: string;
    value?: string;
    inlineValue?: boolean;
};

const getOwn = (object: object, key: string): any =>
    hasOwn(object, key) ? (object as any)[key] : undefined;

const parseError = (code: string, message: string) =>
    nodeError(new TypeError(message), code);

export function parseArgs(config: ParseArgsConfig = {}) {
    if (config === null || typeof config !== "object") {
        throw invalidArgType("config", "of type object", config);
    }
    const args: string[] =
        getOwn(config, "args") ??
        (globalThis as any).process?.argv?.slice(2) ??
        [];
    const strict: boolean = getOwn(config, "strict") ?? true;
    const allowPositionals: boolean =
        getOwn(config, "allowPositionals") ?? !strict;
    const allowNegative: boolean = getOwn(config, "allowNegative") ?? false;
    const options: Record<string, OptionConfig> =
        getOwn(config, "options") ?? {};
    if (!Array.isArray(args)) {
        throw invalidArgType("args", "an instance of Array", args);
    }
    for (const [name, option] of Object.entries(options)) {
        if (option === null || typeof option !== "object") {
            throw invalidArgType(`options.${name}`, "of type object", option);
        }
        const type = getOwn(option, "type");
        if (type !== "string" && type !== "boolean") {
            throw invalidArgValue(
                `options.${name}.type`,
                type,
                "must be one of: 'string', 'boolean'"
            );
        }
        const short = getOwn(option, "short");
        if (short !== undefined) {
            validateString(short, `options.${name}.short`);
            if (short.length !== 1) {
                throw invalidArgValue(
                    `options.${name}.short`,
                    short,
                    "must be a single character"
                );
            }
        }
    }

    const typeOf = (name: string): string | undefined =>
        hasOwn(options, name) ? getOwn(options[name], "type") : undefined;
    const longOf = (short: string) =>
        Object.keys(options).find(
            (name) => getOwn(options[name], "short") === short
        ) ?? short;

    // tokens
    const tokens: Token[] = [];
    const remaining = args.slice();
    let index = -1;
    let groupCount = 0;
    const option = (
        name: string,
        rawName: string,
        value?: string,
        inlineValue?: boolean
    ) =>
        tokens.push({
            kind: "option",
            name,
            rawName,
            index,
            value,
            inlineValue
        });
    // --name or -n: a string option takes the next argument
    const takeValue = (name: string, rawName: string) => {
        if (typeOf(name) === "string" && remaining[0] != null) {
            option(name, rawName, remaining.shift(), false);
            index++;
        } else {
            option(name, rawName);
        }
    };
    while (remaining.length > 0) {
        const arg = remaining.shift();
        if (groupCount > 0) groupCount--;
        else index++;
        if (arg === "--") {
            tokens.push({ kind: "option-terminator", index });
            for (const value of remaining) {
                tokens.push({ kind: "positional", index: ++index, value });
            }
            break;
        }
        if (arg.length > 1 && arg[0] === "-" && arg[1] !== "-") {
            const name = longOf(arg[1]);
            if (arg.length === 2) {
                takeValue(name, arg);
            } else if (typeOf(name) === "string") {
                // -fVALUE
                option(name, `-${arg[1]}`, arg.slice(2), true);
            } else {
                // -abc is -a -b -c, a string option takes the rest
                const expanded: string[] = [];
                for (let i = 1; i < arg.length; i++) {
                    if (
                        typeOf(longOf(arg[i])) !== "string" ||
                        i === arg.length - 1
                    ) {
                        expanded.push(`-${arg[i]}`);
                    } else {
                        expanded.push(`-${arg.slice(i)}`);
                        break;
                    }
                }
                remaining.unshift(...expanded);
                groupCount = expanded.length;
            }
        } else if (arg.length > 2 && arg.startsWith("--")) {
            const equal = arg.indexOf("=", 3);
            if (equal === -1) {
                takeValue(arg.slice(2), arg);
            } else {
                const name = arg.slice(2, equal);
                option(name, `--${name}`, arg.slice(equal + 1), true);
            }
        } else {
            tokens.push({ kind: "positional", index, value: arg });
        }
    }

    // values
    const values: Record<string, unknown> = Object.create(null);
    const positionals: string[] = [];
    for (const token of tokens) {
        if (token.kind === "positional") {
            if (!allowPositionals) {
                throw parseError(
                    "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
                    `Unexpected argument '${token.value}'. This command does not take positional arguments`
                );
            }
            positionals.push(token.value);
            continue;
        }
        if (token.kind !== "option") continue;
        let { name, value, rawName } = token;
        let stored: unknown = value;
        if (
            allowNegative &&
            name.startsWith("no-") &&
            value === undefined &&
            typeOf(name.slice(3)) === "boolean"
        ) {
            name = name.slice(3);
            stored = false;
        }
        if (strict) {
            if (!hasOwn(options, name)) {
                throw parseError(
                    "ERR_PARSE_ARGS_UNKNOWN_OPTION",
                    `Unknown option '${rawName}'${
                        allowPositionals
                            ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${JSON.stringify(rawName)}`
                            : ""
                    }`
                );
            }
            const short = getOwn(options[name], "short");
            const shortAndLong = `${short ? `-${short}, ` : ""}--${name}`;
            const type = typeOf(name);
            let problem: string | undefined;
            if (type === "string" && typeof value !== "string") {
                problem = `Option '${shortAndLong} <value>' argument missing`;
            } else if (type === "boolean" && value != null) {
                problem = `Option '${shortAndLong}' does not take an argument`;
            } else if (
                !token.inlineValue &&
                typeof value === "string" &&
                value.length > 1 &&
                value[0] === "-"
            ) {
                const example = rawName.startsWith("--")
                    ? `'${rawName}=-XYZ'`
                    : `'--${name}=-XYZ' or '${rawName}-XYZ'`;
                problem = `Option '${rawName}' argument is ambiguous.\nDid you forget to specify the option argument for '${rawName}'?\nTo specify an option argument starting with a dash use ${example}.`;
            }
            if (problem) {
                throw parseError(
                    "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
                    problem
                );
            }
        }
        if (name === "__proto__") continue;
        stored ??= true;
        if (hasOwn(options, name) && getOwn(options[name], "multiple")) {
            ((values[name] ??= []) as unknown[]).push(stored);
        } else {
            values[name] = stored;
        }
    }

    for (const [name, option] of Object.entries(options)) {
        const defaultValue = getOwn(option, "default");
        if (defaultValue !== undefined && values[name] === undefined) {
            values[name] = defaultValue;
        }
    }
    const result: {
        values: Record<string, unknown>;
        positionals: string[];
        tokens?: Token[];
    } = { values, positionals };
    if (getOwn(config, "tokens")) result.tokens = tokens;
    return result;
}
