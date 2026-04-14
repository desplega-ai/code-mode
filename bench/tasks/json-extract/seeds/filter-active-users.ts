/**
 * @name filterActiveUsers
 * @description Read a users JSON file and return emails of users where active is true.
 * @tags json, filter, users
 */
import { readFileSync } from "node:fs";

export interface Args {
  path: string;
}

export default async function filterActiveUsers(args: Args): Promise<string[]> {
  const data = JSON.parse(readFileSync(args.path, "utf8")) as {
    users: { email: string; active: boolean }[];
  };
  return data.users.filter((u) => u.active).map((u) => u.email);
}
