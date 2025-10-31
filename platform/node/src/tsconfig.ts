export const compilerOptions = {
    esModuleInterop: true,
    module: "es2022",
    target: "es2022",
    moduleResolution: "bundler",
    allowJs: true,
    lib: ["dom", "dom.iterable", "es2023"],
    jsx: "react",
    typeRoots: ["../.fullstacked_modules/@types", "./node_modules/@types"]
};
