import { describe, it, expect } from "vitest";
import { Camera, extractFrustumPlanes, isSphereInFrustum } from "./camera";

describe("Frustum Culling Accuracy", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);

    it("culls entity far to the left", () => {
        expect(isSphereInFrustum(planes, -15, 0, -50, 0.5)).toBe(false);
    });

    it("culls entity far to the right", () => {
        expect(isSphereInFrustum(planes, 15, 0, -50, 0.5)).toBe(false);
    });

    it("culls entity far above", () => {
        expect(isSphereInFrustum(planes, 0, 12, -50, 0.5)).toBe(false);
    });

    it("culls entity far below", () => {
        expect(isSphereInFrustum(planes, 0, -12, -50, 0.5)).toBe(false);
    });

    it("keeps entity at center", () => {
        expect(isSphereInFrustum(planes, 0, 0, -50, 0.5)).toBe(true);
    });

    it("keeps entity at edge (partially inside)", () => {
        expect(isSphereInFrustum(planes, 10.3, 0, -50, 0.5)).toBe(true);
    });

    it("large sphere near edge stays visible", () => {
        expect(isSphereInFrustum(planes, 12, 0, -50, 3.0)).toBe(true);
    });
});
