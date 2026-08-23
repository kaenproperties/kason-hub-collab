import { describe, expect, it } from "vitest";
import { splitInclusiveSst } from "./inclusive-sst";

describe("splitInclusiveSst", () => {
  it("splits RM500 inclusive of 8% into an exact RM500 total", () => {
    expect(splitInclusiveSst("500.00", "8")).toEqual({
      base: "462.96",
      sst: "37.04",
      total: "500.00",
    });
  });

  it("keeps zero and zero-rated amounts exact", () => {
    expect(splitInclusiveSst("0.00", 8)).toEqual({ base: "0.00", sst: "0.00", total: "0.00" });
    expect(splitInclusiveSst("12.34", 0)).toEqual({ base: "12.34", sst: "0.00", total: "12.34" });
  });

  it("rejects invalid rates and negative gross amounts", () => {
    expect(() => splitInclusiveSst("10.00", -1)).toThrow(/invalid SST rate/);
    expect(() => splitInclusiveSst("-10.00", 8)).toThrow(/must not be negative/);
  });
});
