import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	ResolveFnOutput, ResolveHookContext,
} from 'node:module';
import { resolveTsPath } from '../../utils/resolve-ts-path.js';
import type { NodeError } from '../../types.js';
import { isRelativePathPattern } from '../../utils/is-relative-path-pattern.js';
import {
	tsconfigPathsMatcher,
	tsExtensionsPattern,
	getFormatFromFileUrl,
	fileProtocol,
	allowJs,
	type MaybePromise,
} from './utils.js';
import { active } from './initialize.js';

const isDirectoryPattern = /\/(?:$|\?)/;

type NextResolve = (
	specifier: string,
	context?: ResolveHookContext,
) => MaybePromise<ResolveFnOutput>;

type resolve = (
	specifier: string,
	context: ResolveHookContext,
	nextResolve: NextResolve,
	recursiveCall?: boolean,
) => MaybePromise<ResolveFnOutput>;

const resolveExplicitPath = async (
	defaultResolve: NextResolve,
	specifier: string,
	context: ResolveHookContext,
) => {
	const resolved = await defaultResolve(specifier, context);

	if (
		!resolved.format
		&& resolved.url.startsWith(fileProtocol)
	) {
		resolved.format = await getFormatFromFileUrl(resolved.url);
	}

	return resolved;
};

const extensions = ['.js', '.json', '.ts', '.tsx', '.jsx'] as const;

const tryExtensions = async (
	specifier: string,
	context: ResolveHookContext,
	defaultResolve: NextResolve,
) => {
	const [specifierWithoutQuery, query] = specifier.split('?');
	let throwError: Error | undefined;
	for (const extension of extensions) {
		try {
			return await resolveExplicitPath(
				defaultResolve,
				specifierWithoutQuery + extension + (query ? `?${query}` : ''),
				context,
			);
		} catch (_error) {
			if (
				throwError === undefined
				&& _error instanceof Error
			) {
				const { message } = _error;
				_error.message = _error.message.replace(`${extension}'`, "'");
				_error.stack = _error.stack!.replace(message, _error.message);
				throwError = _error;
			}
		}
	}

	throw throwError;
};

const tryDirectory = async (
	specifier: string,
	context: ResolveHookContext,
	defaultResolve: NextResolve,
) => {
	const isExplicitDirectory = isDirectoryPattern.test(specifier);
	const appendIndex = isExplicitDirectory ? 'index' : '/index';
	const [specifierWithoutQuery, query] = specifier.split('?');

	try {
		return await tryExtensions(
			specifierWithoutQuery + appendIndex + (query ? `?${query}` : ''),
			context,
			defaultResolve,
		);
	} catch (_error) {
		if (!isExplicitDirectory) {
			try {
				return await tryExtensions(specifier, context, defaultResolve);
			} catch {}
		}

		const error = _error as Error;
		const { message } = error;
		error.message = error.message.replace(`${appendIndex.replace('/', path.sep)}'`, "'");
		error.stack = error.stack!.replace(message, error.message);
		throw error;
	}
};

export const resolve: resolve = async (
	specifier,
	context,
	defaultResolve,
	recursiveCall,
) => {
	if (!active) {
		return defaultResolve(specifier, context);
	}

	// If directory, can be index.js, index.ts, etc.
	if (isDirectoryPattern.test(specifier)) {
		return await tryDirectory(specifier, context, defaultResolve);
	}

	const isPath = (
		specifier.startsWith(fileProtocol)
		|| isRelativePathPattern.test(specifier)
	);

	if (
		tsconfigPathsMatcher
		&& !isPath // bare specifier
		&& !context.parentURL?.includes('/node_modules/')
	) {
		const possiblePaths = tsconfigPathsMatcher(specifier);
		for (const possiblePath of possiblePaths) {
			try {
				return await resolve(
					pathToFileURL(possiblePath).toString(),
					context,
					defaultResolve,
				);
			} catch {}
		}
	}

	// Typescript gives .ts, .cts, or .mts priority over actual .js, .cjs, or .mjs extensions
	//
	// If `allowJs` is set in `tsconfig.json`, then we'll apply the same resolution logic
	// to files without a TypeScript extension.
	if (tsExtensionsPattern.test(context.parentURL!) || allowJs) {
		const tsPaths = resolveTsPath(specifier);
		if (tsPaths) {
			for (const tsPath of tsPaths) {
				try {
					return await resolveExplicitPath(defaultResolve, tsPath, context);
					// return await resolve(tsPath, context, defaultResolve, true);
				} catch (error) {
					const { code } = error as NodeError;
					if (
						code !== 'ERR_MODULE_NOT_FOUND'
						&& code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
					) {
						throw error;
					}
				}
			}
		}
	}

	try {
		return await resolveExplicitPath(defaultResolve, specifier, context);
	} catch (error) {
		if (
			error instanceof Error
			&& !recursiveCall
		) {
			const { code } = error as NodeError;
			if (code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
				try {
					return await tryDirectory(specifier, context, defaultResolve);
				} catch (error_) {
					if ((error_ as NodeError).code !== 'ERR_PACKAGE_IMPORT_NOT_DEFINED') {
						throw error_;
					}
				}
			}

			if (code === 'ERR_MODULE_NOT_FOUND') {
				try {
					return await tryExtensions(specifier, context, defaultResolve);
				} catch {}
			}
		}

		throw error;
	}
};