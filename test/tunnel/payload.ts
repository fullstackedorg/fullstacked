// deterministic bytes so a test can check a large message arrived intact
export function payload(size: number) {
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 251;
    }
    return data;
}
