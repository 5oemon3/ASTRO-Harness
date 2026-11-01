import { expect, test } from "bun:test";
import { groupModels, type ModelOption } from "../src/tui/models";

const option = (provider: string, id: string): ModelOption => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  tags: [],
  context: 8192,
  status: "active",
});

test("groupModels agrupa por provider, ordena cabeçalhos e preserva a ordem interna", () => {
  const models = [option("codex", "b"), option("nvidia", "z"), option("nvidia", "a"), option("codex", "a")];
  const groups = groupModels(models);
  expect(groups.map((group) => group.provider)).toEqual(["codex", "nvidia"]);
  expect(groups[0]?.models.map((model) => model.id)).toEqual(["b", "a"]);
  expect(groups[1]?.models.map((model) => model.id)).toEqual(["z", "a"]);
});

test("groupModels com lista vazia retorna lista vazia", () => {
  expect(groupModels([])).toEqual([]);
});
