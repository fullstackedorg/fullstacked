export default function authenticate(url: string): Promise<string> {
    if (globalThis.authenticate) {
        return globalThis.authenticate(url);
    }

    const width = 500;
    const height = 600;
    const left = window.screenX + (window.innerWidth - width) / 2;
    const top = window.screenY + (window.innerHeight - height) / 2;
    const authWin = window.open(url, 'Authenticate', `width=${width},height=${height},left=${left},top=${top}`);

    return new Promise<string>((resolve, reject) => {
        authWin.onmessage = (event) => {
            const response = event.data;
            authWin.close();
            resolve(response);
        }
        authWin.onclose = () => {
            reject(new Error('Authentication cancelled'));
        }
    });
}