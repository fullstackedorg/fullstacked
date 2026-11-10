// Libraries like React pick their build from process.env.NODE_ENV at bundle time.
function describeTheCurrentBuildMode(): string {
    if (process.env.NODE_ENV === "production") {
        return "production build";
    }
    return "development build";
}

document.body.textContent = describeTheCurrentBuildMode();
