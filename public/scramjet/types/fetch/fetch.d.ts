import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchHandler, ScramjetFetchParsed, ScramjetFetchRequest, ScramjetFetchResponse } from ".";
import { ScramjetHeaders } from "@/shared";
export declare function doHandleFetch(handler: ScramjetFetchHandler, request: ScramjetFetchRequest): Promise<ScramjetFetchResponse>;
export declare function doNetworkFetch(handler: ScramjetFetchHandler, request: ScramjetFetchRequest, parsed: ScramjetFetchParsed, newheaders: ScramjetHeaders): Promise<BareResponse>;
