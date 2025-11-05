import { propertiesDefaultingToPx, CSSProperties } from "../style";

const propertiesDefaultingToPxArr = Object.keys(propertiesDefaultingToPx);
const allCSSProperties = [];
for (const property in document.body.style) {
    allCSSProperties.push(property);
}

const styles: [string, string][] = [];

function createStyle(tag: string, cssProperties: CSSProperties) {
    const tempElement = document.createElement("div");

    Object.entries(cssProperties).forEach(([property, value]) => {
        if (
            propertiesDefaultingToPxArr.includes(property) &&
            value &&
            typeof value === "number"
        ) {
            value = value + "px";
        } else if (!allCSSProperties.includes(property)) {
            const nestedTag = property.startsWith("&")
                ? `${tag}${property.slice(1)}`
                : `${tag} ${property}`;

            return createStyle(nestedTag, value);
        }

        tempElement.style[property] = value;
    });

    const cssString = tempElement.style.cssText;
    tempElement.remove();

    styles.push([tag, cssString]);
}

export function createClass(name: string, cssProperties: CSSProperties) {
    createStyle("." + name, cssProperties);
    return name;
}

export function exportStyles() {
    return styles
        .toReversed()
        .map(([tag, cssString]) => `${tag}{${cssString}}`)
        .join(" ");
}

const style = {
    createClass
};

export default style;
