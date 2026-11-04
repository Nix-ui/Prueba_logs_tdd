import multiplicar from "./multiplicador.js";

describe("Multiplicar", () => {
	it("deberia multiplicar 2 numeros", () => {
		expect(multiplicar(3, 3)).toEqual(9);
	});
});
