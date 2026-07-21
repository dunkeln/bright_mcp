import type { DatasetResult } from "../core/contracts";

export const devDatasetResult = {
  schemaVersion: 1,
  resultId: "preview-products-1",
  dataset: {
    id: "preview-products",
    title: "Wireless earbuds",
  },
  operation: "search",
  columns: [
    { key: "title", label: "Product", type: "string" },
    { key: "brand", label: "Brand", type: "string" },
    { key: "price", label: "Price", type: "number" },
    { key: "rating", label: "Rating", type: "number" },
    { key: "inStock", label: "In stock", type: "boolean" },
  ],
  rows: [
    {
      title: "QuietBuds Pro",
      brand: "Auralite",
      price: 79.99,
      rating: 4.7,
      inStock: true,
    },
    {
      title: "Commuter Mini",
      brand: "Northstar Audio",
      price: 49,
      rating: 4.4,
      inStock: true,
    },
    {
      title: "Studio Air 2",
      brand: "Kindred Sound",
      price: 129.5,
      rating: 4.8,
      inStock: false,
    },
    {
      title: "Everyday Pods",
      brand: "Juniper",
      price: 34.95,
      rating: 4.1,
      inStock: true,
    },
    {
      title: "TrailBeat Sport",
      brand: "Summit",
      price: 64,
      rating: 4.5,
      inStock: true,
    },
  ],
  rowRefs: [
    "preview-row-1",
    "preview-row-2",
    "preview-row-3",
    "preview-row-4",
    "preview-row-5",
  ],
  page: {
    truncated: true,
    totalRows: 128,
  },
  artifact: {
    uri: "bright://results/preview-products-1",
    mediaType: "application/json",
  },
  warnings: [
    {
      code: "preview_fixture",
      message: "Local preview data — no Bright Data request was made.",
    },
  ],
} satisfies DatasetResult;
