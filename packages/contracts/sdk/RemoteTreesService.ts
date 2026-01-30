// Dynamic import to avoid ESM/CJS conflict
let _ky: any = null;
async function getKy() {
  if (!_ky) { _ky = (await import("ky")).default; }
  return _ky;
}
import type { ElementOf } from "ts-essentials";
import type { TreesService } from "./TreesService";

export const REMOTE_TREES_ALLOWED_METHODS = [
  "getTreeRoots",
  "getNoteConsumptionInputs",
  "noteExistsAndNotNullified",
] satisfies (keyof TreesService)[];
export type ITreesService = Pick<
  TreesService,
  ElementOf<typeof REMOTE_TREES_ALLOWED_METHODS>
>;

export interface RemoteTreesService extends ITreesService {}
export class RemoteTreesService {
  constructor(private url: string) {
    for (const method of REMOTE_TREES_ALLOWED_METHODS) {
      (this as any)[method] = async (...args: any[]) => {
        const ky = await getKy();
        return await ky
          .post(this.url, {
            json: {
              method,
              args,
            },
          })
          .json();
      };
    }
  }
}
