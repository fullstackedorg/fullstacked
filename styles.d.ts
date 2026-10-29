// Stylesheets are imported for their side effect: the bundler (esbuild in
// the core) emits them next to the script, there is nothing to type.
declare module "*.css";
declare module "*.scss";
