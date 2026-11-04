import division from "./division.js";

describe("Division", () => {
	it("debe division 2 numeros", () => {
		expect(division(9, 3)).toEqual(3);
	});
});
