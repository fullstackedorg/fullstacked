export default new Proxy(
    {},
    {
        get() {
            throw "unavailable";
        }
    }
);
