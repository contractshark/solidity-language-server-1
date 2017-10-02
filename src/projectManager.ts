import { Observable } from "@reactivex/rxjs";
import * as _ from "lodash";

import { path2uri, toUnixPath, uri2path } from "./core";
import { FileSystemUpdater } from "./fs";
import { Logger, NoopLogger } from "./logging";
import { InMemoryFileSystem } from "./memfs";
import { resolveModuleName } from "./moduleNameResolver";
import { preProcessFile } from "./services/preProcessFile";

export class ProjectManager {
    /**
     * Root path with slashes
     */
    private rootPath: string;

    /**
     * URI -> version map. Every time file content is about to change or changed (didChange/didOpen/...), we are incrementing it's version
     * signalling that file is changed and file's user must invalidate cached and requery file content
     */
    private versions: Map<string, number>;

    /**
     * Local side of file content provider which keeps cache of fetched files
     */
    private inMemoryFs: InMemoryFileSystem;

    /**
     * File system updater that takes care of updating the in-memory file system
     */
    private updater: FileSystemUpdater;

    /**
     * @return local side of file content provider which keeps cached copies of fethed files
     */
    getFs(): InMemoryFileSystem {
        return this.inMemoryFs;
    }

    /**
     * @param filePath file path (both absolute or relative file paths are accepted)
     * @return true if there is a fetched file with a given path
     */
    hasFile(filePath: string) {
        return this.inMemoryFs.fileExists(filePath);
    }

    /**
     * A URI Map from file to files referenced by the file, so files only need to be pre-processed once
     */
    private referencedFiles = new Map<string, Observable<string>>();

    /**
     * @param rootPath root path as passed to `initialize`
     * @param inMemoryFileSystem File system that keeps structure and contents in memory
     */
    constructor(
        rootPath: string,
        inMemoryFileSystem: InMemoryFileSystem,
        updater: FileSystemUpdater,
        protected logger: Logger = new NoopLogger()
    ) {
        this.rootPath = rootPath;
        this.updater = updater;
        this.inMemoryFs = inMemoryFileSystem;
        this.versions = new Map<string, number>();
    }

    /**
     * Called when file was opened by client. Current implementation
     * does not differenciates open and change events
     * @param uri file's URI
     * @param text file's content
     */
    didOpen(uri: string, text: string) {
        this.didChange(uri, text);
    }

    /**
     * Called when file was closed by client. Current implementation invalidates compiled version
     * @param uri file's URI
     */
    didClose(uri: string) {
        this.inMemoryFs.didClose(uri);
        let version = this.versions.get(uri) || 0;
        this.versions.set(uri, ++version);
    }

    /**
     * Called when file was changed by client. Current implementation invalidates compiled version
     * @param uri file's URI
     * @param text file's content
     */
    didChange(uri: string, text: string) {
        this.inMemoryFs.didChange(uri, text);
        let version = this.versions.get(uri) || 0;
        this.versions.set(uri, ++version);
    }

    /**
     * Called when file was saved by client
     * @param uri file's URI
     */
    didSave(uri: string) {
        this.inMemoryFs.didSave(uri);
    }

    /**
     * Recursively collects file(s) dependencies up to given level.
     * Dependencies are extracted by TS compiler from import and reference statements
     *
     * Dependencies include:
     * - all the configuration files
     * - files referenced by the given file
     * - files included by the given file
     *
     * The return values of this method are not cached, but those of the file fetching and file processing are.
     *
     * @param uri File to process
     * @param maxDepth Stop collecting when reached given recursion level
     * @param ignore Tracks visited files to prevent cycles
     * @param childOf OpenTracing parent span for tracing
     * @return Observable of file URIs ensured
     */
    ensureReferencedFiles(uri: string, maxDepth = 30, ignore = new Set<string>()): Observable<string> {
        ignore.add(uri);
        // If max depth was reached, don't go any further
        return Observable.defer(() => maxDepth === 0 ? Observable.empty<never>() : this.resolveReferencedFiles(uri))
            // Prevent cycles
            .filter(referencedUri => !ignore.has(referencedUri))
            // Call method recursively with one less dep level
            .mergeMap(referencedUri =>
                this.ensureReferencedFiles(referencedUri, maxDepth - 1, ignore)
                    // Continue even if an import wasn't found
                    .catch((err: any) => {
                        this.logger.error(`Error resolving file references for ${uri}:`, err);
                        return [];
                    })
            );
    }

    /**
     * Returns the files that are referenced from a given file.
     * If the file has already been processed, returns a cached value.
     *
     * @param uri URI of the file to process
     * @return URIs of files referenced by the file
     */
    private resolveReferencedFiles(uri: string): Observable<string> {
        let observable = this.referencedFiles.get(uri);
        if (observable) {
            return observable;
        }
        observable = this.updater.ensure(uri)
            .concat(Observable.defer(() => {
                const referencingFilePath = uri2path(uri);
                const contents = this.inMemoryFs.getContent(uri);
                const info = preProcessFile(contents);
                // Iterate imported files
                return Observable.from(info.importedFiles)
                    .map(importedFile => resolveModuleName(importedFile.fileName, toUnixPath(referencingFilePath), this.inMemoryFs))
                    .filter(resolved => !!(resolved && resolved.resolvedModule))
                    .map(resolved => resolved.resolvedModule!.resolvedFileName);
            }))
            // Use same scheme, slashes, host for referenced URI as input file
            .map(filePath => path2uri(filePath))
            // Don't cache errors
            .do(_.noop, (_err: any) => {
                this.referencedFiles.delete(uri);
            })
            // Make sure all subscribers get the same values
            .publishReplay()
            .refCount();
        this.referencedFiles.set(uri, observable);
        return observable;
    }
}