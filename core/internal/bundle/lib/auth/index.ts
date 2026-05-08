export default function authenticate(url: string): Promise<string> {
    if (globalThis.authenticate) {
        return globalThis.authenticate(url);
    }

    const width = 500;
    const height = 600;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;
    const authWin = window.open(url, undefined, `width=${width},height=${height},left=${left},top=${top}`);

    return new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
            if (authWin.closed) {
                clearInterval(timer);
                reject(new Error('Authentication cancelled'));
                window.removeEventListener("message", onmessage);
            }
        }, 500);

        const onmessage = (event: MessageEvent) => {
            clearInterval(timer);
            authWin.close();
            resolve(event.data);
            window.removeEventListener("message", onmessage);
        };

        window.addEventListener("message", onmessage);
    });
}