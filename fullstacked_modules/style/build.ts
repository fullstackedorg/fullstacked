import {
    CSSAnimationProperties,
    propertiesDefaultingToPx,
    CSSProperties
} from "../style";

const propertiesDefaultingToPxArr = Object.keys(propertiesDefaultingToPx);
const allCSSProperties = [];
for (const property in document.body.style) {
    allCSSProperties.push(property);
}

type StyleItem = {
    element: HTMLElement;
    order: number;
    children: StyleTree;
    type: "style";
};

type StyleTree = {
    [name: string]: StyleItem | AnimationItem;
};

type AnimationItem = {
    element: null;
    order: number;
    children: StyleTree;
    type: "animation";
};

const styles: StyleTree = {};
let order = 0;

function getOrCreateParentFromPath(path: string[], parent = styles): StyleTree {
    if (path.length === 0) {
        return parent;
    }

    const child = path.shift();
    if (!parent[child]) {
        parent[child] = {
            element: document.createElement("div"),
            order: order++,
            children: {},
            type: "style"
        };
    }

    return getOrCreateParentFromPath(path, parent[child].children);
}

function createStyle(
    cssProperties: CSSProperties,
    path: string[],
    existing: StyleItem
) {
    const styleItem = existing || {
        element: document.createElement("div"),
        order: order++,
        children: {},
        type: "style"
    };

    Object.entries(cssProperties).forEach(([property, value]) => {
        if (!allCSSProperties.includes(property)) {
            if (property.startsWith("@media")) {
                const parentPath = [property, ...path];
                _createClass(
                    parentPath,
                    value,
                    getOrCreateParentFromPath(parentPath.slice(0, -1))
                );
            } else {
                _createClass([...path, property], value, styleItem.children);
            }
        } else {
            if (
                propertiesDefaultingToPxArr.includes(property) &&
                value &&
                typeof value === "number"
            ) {
                value = value + "px";
            }

            styleItem.element.style[property] = value;
        }
    });

    return styleItem;
}

function _createClass(
    path: string[],
    cssProperties: CSSProperties,
    parent = styles
) {
    parent[path.at(-1)] = createStyle(
        cssProperties,
        path,
        parent[path.at(-1)] as StyleItem
    );
}

export function createClass(name: string, cssProperties: CSSProperties) {
    _createClass(["." + name], cssProperties);
    return name;
}

export function createGlobalStyle(globalCssProperties: CSSProperties) {
    Object.entries(globalCssProperties).forEach(([name, cssProperties]) => {
        styles[name] = createStyle(
            cssProperties,
            [name],
            styles[name] as StyleItem
        );
    });
}

export function createAnimation(
    name: string,
    cssAnimationProperties: CSSAnimationProperties
) {
    styles[name] = {
        ...(createStyle(
            cssAnimationProperties,
            [name],
            styles[name] as StyleItem
        ) as any),
        order: -1,
        type: "animation"
    };
    return name;
}

function constructClassName(path: string[]) {
    return path.reduce(
        (str, item) =>
            str + (item.startsWith("&") ? item.slice(1) : ` ${item}`),
        ""
    );
}

function generateStyleRecusively(path: string[] = [], parent = styles) {
    return Object.entries(parent)
        .sort(([_, itemA], [__, itemB]) => itemA.order - itemB.order)
        .map(([tag, styleItem]) => {
            if (styleItem.type === "animation") {
                return `@keyframes ${tag} { ${generateStyleRecusively([], styleItem.children)} }`;
            }

            let css = "";

            const currentPath = [...path, tag];

            const cssString = styleItem.element.style.cssText;

            if (cssString) {
                css += `${constructClassName(currentPath)} { ${cssString} } `;
            }

            if (styleItem.children) {
                if (tag.startsWith("@media")) {
                    css += `${tag} { ${generateStyleRecusively(
                        currentPath.slice(1),
                        styleItem.children
                    )} }`;
                } else {
                    css += generateStyleRecusively(
                        currentPath,
                        styleItem.children
                    );
                }
            }

            styleItem.element.remove();

            return css;
        })
        .flat()
        .join("");
}

export function exportStyles() {
    return generateStyleRecusively();
}

const style = {
    createClass,
    createGlobalStyle,
    createAnimation
};

export default style;
