import * as vscode from 'vscode';
import { GraphModel } from './model';
import { GraphNode, NodeKind } from './types';

/**
 * Symbol provider integration for expanding file nodes
 */
export class SymbolProvider {
	private model: GraphModel;

	constructor(model: GraphModel) {
		this.model = model;
	}

	/**
	 * Expand a file node to show its symbols
	 */
	async expandFile(nodeId: string): Promise<void> {
		const node = this.model.getNode(nodeId);
		if (!node || node.kind !== NodeKind.File) {
			return;
		}

		// Check if already expanded
		if (node.isExpanded) {
			return;
		}

		// Check node limit before even fetching symbols
		if (this.model.isOverNodeLimit()) {
			vscode.window.showWarningMessage(`Node limit (${this.model.getFilters().maxNodes}) reached. Increase limit in filters.`);
			return;
		}

		const fileUri = vscode.Uri.parse(node.uri!);

		try {
			// Execute document symbol provider
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				fileUri
			);

			if (!symbols || symbols.length === 0) {
				// File has no symbols, mark as leaf
				node.isLeaf = true;
				this.model.setNodeExpanded(nodeId, true);
				return;
			}

			// Collect ALL nodes/edges into plain arrays first — zero model writes.
			const nodesToAdd: GraphNode[] = [];
			const edgesToAdd: Array<{ from: string; to: string }> = [];

			this.collectSymbols(fileUri, symbols, nodeId, '', 0, nodesToAdd, edgesToAdd);

			// Mark the file node expanded silently (no extra notification),
			// then flush the entire batch with a single notifyUpdate.
			node.isExpanded = true;
			this.model.addBatch(nodesToAdd, edgesToAdd);

		} catch (error) {
			console.error('Error expanding file symbols:', error);
			// Mark as leaf if we can't get symbols
			node.isLeaf = true;
			this.model.setNodeExpanded(nodeId, true);
		}
	}

	/**
	 * Recursively collect symbols into pre-allocated arrays.
	 * No model mutations happen here — callers batch-commit the result.
	 */
	private collectSymbols(
		fileUri: vscode.Uri,
		symbols: vscode.DocumentSymbol[],
		parentId: string,
		symbolPath: string,
		depth: number,
		nodesToAdd: GraphNode[],
		edgesToAdd: Array<{ from: string; to: string }>
	): void {
		const filters = this.model.getFilters();
		const maxSymbolDepth = filters.maxSymbolDepth ?? 5;

		// Hard stop: depth exceeded
		if (depth >= maxSymbolDepth) {
			return;
		}

		for (const symbol of symbols) {
			// Check limit against model size PLUS pending batch to stay accurate
			if (this.model.getNodeCount() + nodesToAdd.length >= filters.maxNodes) {
				break;
			}

			const mappedKind = this.mapSymbolKind(symbol.kind);

			// Respect hidden kinds filter — skip node creation but still recurse
			// into children so nested visible symbols are not silently dropped.
			if (filters.hiddenKinds && filters.hiddenKinds.includes(mappedKind)) {
				if (symbol.children && symbol.children.length > 0) {
					this.collectSymbols(fileUri, symbol.children, parentId, symbolPath, depth, nodesToAdd, edgesToAdd);
				}
				continue;
			}

			const currentSymbolPath = symbolPath ? `${symbolPath}.${symbol.name}` : symbol.name;
			const symbolId = this.createSymbolId(fileUri, currentSymbolPath, symbol.range);

			nodesToAdd.push({
				id: symbolId,
				label: symbol.name,
				kind: mappedKind,
				uri: fileUri.toString(),
				range: symbol.range,
				isExpanded: false,
				isLeaf: !symbol.children || symbol.children.length === 0
			});
			edgesToAdd.push({ from: parentId, to: symbolId });

			// Recurse into children at the next depth level
			if (symbol.children && symbol.children.length > 0) {
				this.collectSymbols(fileUri, symbol.children, symbolId, currentSymbolPath, depth + 1, nodesToAdd, edgesToAdd);
			}
		}
	}


	/**
	 * Create a stable symbol ID
	 */
	private createSymbolId(uri: vscode.Uri, symbolPath: string, range: vscode.Range): string {
		return `${uri.toString()}::${symbolPath}::${range.start.line}:${range.start.character}`;
	}

	/**
	 * Map VS Code symbol kind to our NodeKind
	 */
	private mapSymbolKind(kind: vscode.SymbolKind): NodeKind {
		switch (kind) {
			case vscode.SymbolKind.Class:
				return NodeKind.Class;
			case vscode.SymbolKind.Function:
				return NodeKind.Function;
			case vscode.SymbolKind.Method:
				return NodeKind.Method;
			case vscode.SymbolKind.Variable:
				return NodeKind.Variable;
			case vscode.SymbolKind.Interface:
				return NodeKind.Interface;
			case vscode.SymbolKind.Enum:
				return NodeKind.Enum;
			case vscode.SymbolKind.Namespace:
			case vscode.SymbolKind.Module:
				return NodeKind.Namespace;
			case vscode.SymbolKind.Property:
			case vscode.SymbolKind.Field:
				return NodeKind.Property;
			case vscode.SymbolKind.Constant:
				return NodeKind.Constant;
			case vscode.SymbolKind.Constructor:
				return NodeKind.Constructor;
			default:
				return NodeKind.Unknown;
		}
	}
}
