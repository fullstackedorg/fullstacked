import style from "style";

const spacing = {
    xs: 5,
    s: 10,
    m: 20,
    l: 30
};

const colors = {
    blue: {
        main: "#007aff",
        accent: "#04b8ec",
        dark: "#1e293b"
    },
    dark: "#15171b",
    red: "#ff453a",
    green: "#30d158",
    yellow: "#ffcc00",
    light: "#ffffff",
    gray: {
        main: "#8c929b",
        dark: "#404958"
    },
    overlay: "#15171b99"
};


function opacity(color: string, opacity: number) {
    return `rgba(${parseInt(color.slice(1, 3), 16)}, ${parseInt(color.slice(3, 5), 16)}, ${parseInt(color.slice(5), 16)}, ${opacity / 100})`;
}

export const snackBarClass = "snack-bar"

export const snackBarsContainerClass = style.createClass("snack-bars-container", {
display: "flex",
    flexDirection: "column",
    gap: spacing.s,
    position: "fixed",
    bottom: 0,
    left: 0,
    zIndex: 100,
    padding: `0 ${spacing.m} ${spacing.m}`,
    alignItems: "flex-start",
    width: "100%",
    pointerEvents: "none",
    textAlign: "left",
    // font-family: typography.$fonts;
    // font-size: typography.$medium;

    maxWidth: 450,
    [`@media (max-width: 450px)`]: {
        alignItems: "center"
    },

    [`.${snackBarClass}`]: {
        pointerEvents: "all",

        backgroundColor: colors.gray.dark,
        borderRadius: spacing.xs,
        color: colors.light,

        minHeight: 42,
        maxWidth: "100%",
        width: "max-content",

        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: spacing.s,

        padding: `${spacing.xs} ${spacing.s}`,

        boxShadow: `0px 4px 10px ${opacity(colors.dark, 60)}`,

        ["> div:first-child"]: {
            padding: `${spacing.xs} 0`,
            width: "100%",
            overflowWrap: "break-word"
        }
    }
})
