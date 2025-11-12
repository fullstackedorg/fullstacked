import CSS from "csstype";

export const propertiesDefaultingToPx = {
    padding: true,
    paddingTop: true,
    paddingRight: true,
    paddingBottom: true,
    paddingLeft: true,

    margin: true,
    marginTop: true,
    marginRight: true,
    marginBottom: true,
    marginLeft: true,

    width: true,
    minWidth: true,
    maxWidth: true,

    height: true,
    minHeight: true,
    maxHeight: true,

    top: true,
    right: true,
    bottom: true,
    left: true,

    gap: true,

    fontSize: true,
    borderRadius: true,
    borderTopLeftRadius: true,
    borderTopRightRadius: true,
    borderBottomLeftRadius: true,
    borderBottomRightRadius: true,

    outlineOffset: true
} as const;

export type CSSProperties =
    | {
          [property in keyof CSS.Properties]: property extends keyof typeof propertiesDefaultingToPx
              ? number | CSS.Properties[property]
              : CSS.Properties[property];
      }
    | {
          [child: string]: CSSProperties;
      };

export const createClass = (name: string, cssProperties: CSSProperties) => name;

export const createGlobalStyle = (cssProperties: CSSProperties) => {};

const style = {
    createClass,
    createGlobalStyle
};

export default style;
