import parentWindow from "fullstacked/parentWindow";
import { getConfig, setConfig } from "./shell/cli/config";

parentWindow.disableAutoWindowSize();

const saveSkipWelcomeUntil = (dontShowAgain: boolean) => {
    const until = dontShowAgain
        ? Number.MAX_SAFE_INTEGER
        : Date.now() + 1000 * 60 * 60 * 24; // 24h

    setConfig("skipWelcomeUntil", until.toString());
};

const getExpectedKeyboard = async () => {
    const config = await getConfig("expectedKeyboard");
    return Boolean(config && config !== "false" && config !== "0");
};

const openTerminal = async () => {
    const isExpectedKeyboard = await getExpectedKeyboard();
    const initShell = (await import("./shell/init")).default;

    if (isExpectedKeyboard) {
        const { ExpectedKeyboard, LAYOUT_QWERTY } =
            await import("./expected-keyboard/src");

        let shellInstance: any = null;
        let fitAddonInstance: any = null;

        const keyboard = new ExpectedKeyboard({
            layout: LAYOUT_QWERTY,
            cornerLabelsVisible: true,
            quickNavVisible: true,
            swipeDeadzone: 10,
            autoAttachInputs: true,
            onInput: (char) => {
                if (shellInstance) {
                    if (char === "\n") {
                        shellInstance.handleInput("\r");
                    } else {
                        shellInstance.handleInput(char);
                    }
                }
            },
            onAction: (action) => {
                if (shellInstance) {
                    switch (action) {
                        case "esc":
                            shellInstance.handleInput("\x1b");
                            break;
                        case "backspace":
                            shellInstance.handleInput("\u007F");
                            break;
                        case "tab":
                            shellInstance.handleInput("\t");
                            break;
                        case "left":
                            shellInstance.handleInput("\x1b[D");
                            break;
                        case "right":
                            shellInstance.handleInput("\x1b[C");
                            break;
                        case "up":
                            shellInstance.handleInput("\x1b[A");
                            break;
                        case "down":
                            shellInstance.handleInput("\x1b[B");
                            break;
                        case "home":
                            shellInstance.handleInput("\x1b[H");
                            break;
                        case "end":
                            shellInstance.handleInput("\x1b[F");
                            break;
                        case "ctrl+c":
                            shellInstance.handleInput("\u0003");
                            break;
                    }
                }
            },
            onVisibilityChange: () => {
                if (fitAddonInstance) {
                    setTimeout(() => fitAddonInstance.fit(), 50);
                    setTimeout(() => fitAddonInstance.fit(), 250);
                }
            }
        });

        const { shell, fitAddon } = await initShell({ keyboard });
        shellInstance = shell;
        fitAddonInstance = fitAddon;
    } else {
        await initShell();
    }
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
