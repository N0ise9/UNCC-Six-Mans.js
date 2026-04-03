declare module "fast-xml-parser" {
  export interface XMLParserOptions {
    attributeNamePrefix?: string;
    ignoreAttributes?: boolean;
  }

  export class XMLParser {
    constructor(options?: XMLParserOptions);
    parse(input: string): unknown;
  }
}
