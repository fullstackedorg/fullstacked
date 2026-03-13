import { getConfig, setConfig } from "./shell/cli/config";

const saveSkipWelcomeUntil = (dontShowAgain: boolean) => {
    const until = dontShowAgain
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + 1000 * 60 * 60 * 24; // 24h

    setConfig("skipWelcomeUntil", until);
};

const openTerminal = async () => {
    await import("./shell");
};

const getSkipWelcomeUntil = async () => {
    const until = await getConfig("skipWelcomeUntil");
    return until ? parseInt(until) : 0;
};

if (Date.now() < (await getSkipWelcomeUntil())) {
    openTerminal();
} else {
    const showWelcomeMessage = (await import("./demo/init")).default;
    showWelcomeMessage((dontShowAgain) => {
        openTerminal();
        saveSkipWelcomeUntil(dontShowAgain);
    });
}
