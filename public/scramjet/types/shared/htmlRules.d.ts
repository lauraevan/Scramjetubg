import { URLMeta } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
export type HtmlRule = {
    [key: string]: "*" | string[] | ((...any: any[]) => string | null);
    fn: (value: string, context: ScramjetContext, meta: URLMeta, attrs?: Record<string, string | undefined>) => string | null;
};
export declare const htmlRules: HtmlRule[];
export declare function findHtmlRule(attribute: string, tagName: string): HtmlRule | undefined;
