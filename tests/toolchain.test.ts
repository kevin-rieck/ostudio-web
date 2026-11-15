import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

describe("npm supply-chain policy", () => {
  it("keeps the enforced toolchain pins aligned with the lockfile and both CI jobs", () => {
    const { engines } = JSON.parse(read("package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    const ci = read(".github/workflows/ci.yml");

    expect(engines).toEqual({ node: "24.15.0", npm: "11.13.0" });
    expect(read(".node-version").trim()).toBe(engines.node);
    expect(lock.packages[""].engines).toEqual(engines);
    expect(read(".npmrc")).toMatch(/^engine-strict=true$/m);
    expect(ci.match(/node-version-file: \.node-version/g)).toHaveLength(2);
    expect(ci.match(/npm install --global npm@11\.13\.0 --ignore-scripts/g)).toHaveLength(2);
  });

  it("sets a seven-day cooldown for npm resolution and Dependabot npm updates", () => {
    expect(read(".npmrc")).toMatch(/^min-release-age=7$/m);
    expect(read(".github/dependabot.yml")).toMatch(
      /package-ecosystem: npm\n[\s\S]*? {4}cooldown:\n {6}default-days: 7\n/,
    );
  });
});
