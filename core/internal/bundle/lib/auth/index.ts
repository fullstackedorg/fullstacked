const defaultWindowFeatures = () => {
    const width = 500;
    const height = 600;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;
    return `width=${width},height=${height},left=${left},top=${top}`;
};

export function authenticate(
    url: string,
    opts?: {
        windowFeatures?: string;
    }
): Promise<any> {
    const urlObj = new URL(url);
    urlObj.searchParams.append("auth", "1");
    url = urlObj.toString();

    const authWin = window.open(
        url,
        undefined,
        opts?.windowFeatures ?? defaultWindowFeatures()
    );

    return new Promise<string>((resolve, reject) => {
        let timer: any = null;
        if (!globalThis.fullstacked && authWin) {
            timer = setInterval(() => {
                try {
                    if (authWin.closed) {
                        clearInterval(timer);
                        reject(new Error("Authentication cancelled"));
                        window.removeEventListener("message", onmessage);
                    }
                } catch {}
            }, 500);
        }

        const onmessage = (event: MessageEvent) => {
            if (timer) clearInterval(timer);

            if (event.data instanceof Error) {
                reject(event.data);
            } else {
                resolve(event.data);
            }

            window.removeEventListener("message", onmessage);
        };

        window.addEventListener("message", onmessage);
    });
}

const auth = {
    authenticate
};

export default auth;
