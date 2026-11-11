// A build plugin whose worker dies while the build waits for it
export default {
    data: { name: "crash", filter: "\\.busy$" },
    callback() {
        setTimeout(() => {
            throw new Error("the plugin's worker crashed");
        });
        return new Promise(() => {});
    }
};
