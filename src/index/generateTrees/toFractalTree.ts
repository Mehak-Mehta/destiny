import path from "path";

import logger from "../../shared/logger";
import { Graph } from "./shared/Graph";
import { findSharedParent } from "./shared/findSharedParent";
import { hasCycle } from "./toFractalTree/hasCycle";
import { RootOption } from "../shared/RootOption";
import { isLinkedFile, linkedFileToOriginal } from "./shared/isLinkedFile";
import chalk from "chalk";
import { fileWithoutExtension } from "../shared/fileWithoutExtension";
import { isTestFile } from "./shared/isTestFile";

export function toFractalTree(graph: Graph, entryPoints: string[]) {
  const tree: RootOption["tree"] = {};
  const treeSet = new Set<string>();
  const dependencies: Record<string, string[]> = {};
  const linkedFiles = new Set<string>();
  let containsCycle = false;

  const addDependency = (key: string, location: string) => {
    if (!Array.isArray(dependencies[key])) {
      dependencies[key] = [];
    }

    dependencies[key].push(location);
  };

  const checkDuplicates = (
    location: string,
    dirname: string,
    filePath: string
  ) => {
    const hasLocation = treeSet.has(location);

    if (hasLocation) {
      const newLocation = path.join(dirname, filePath.replace(/\//g, "-"));
      logger.info(`File renamed: ${filePath} -> ${newLocation}`);

      return newLocation;
    }

    return location;
  };

  const changeImportLocation = (
    filePath: string,
    newLocation: string
  ): void => {
    tree[filePath] = newLocation;

    treeSet.add(newLocation);
  };

  const updateDependencyImportPaths = (
    currentPath: string,
    newFilePath: string
  ): void => {
    const imports = graph[currentPath];
    if (imports?.length > 0) {
      const newDir = path.basename(newFilePath, path.extname(newFilePath));
      const newDirPath = path.dirname(newFilePath);
      for (const importFilePath of imports) {
        const filename = path.basename(importFilePath);
        const newLocation = path.join(newDirPath, newDir, filename);
        changeImportLocation(importFilePath, newLocation);
        updateDependencyImportPaths(importFilePath, tree[importFilePath]);
      }
    }
  };

  const fn = (filePath: string, folderPath: string, graph: Graph) => {
    const basename = path.basename(filePath);
    if (isLinkedFile(basename)) {
      linkedFiles.add(filePath);
      return;
    }

    let directoryName = path.basename(filePath, path.extname(filePath));
    const currentFolder = path.basename(path.dirname(filePath));
    const isGlobal = filePath.includes("..");

    const tempLocation = isGlobal
      ? filePath
      : path.join(
          folderPath,
          directoryName === "index" && currentFolder && currentFolder !== "."
            ? currentFolder + path.extname(filePath)
            : basename
        );

    const location = checkDuplicates(tempLocation, folderPath, filePath);
    directoryName = path.basename(location, path.extname(location));

    if (!isGlobal) {
      changeImportLocation(filePath, location);
    }

    const imports = graph[filePath];

    if (imports?.length > 0) {
      const newDestination = path.join(folderPath, directoryName);

      for (const importFilePath of imports) {
        // if importFilePath includes .. then it's a global
        // we don't store globals in tree, so check if cycle
        if (importFilePath in tree || importFilePath.includes("..")) {
          const cycle = hasCycle(importFilePath, graph, new Set());

          if (cycle) {
            containsCycle = true;
            logger.warn(`Dependency cycle detected: ${cycle.join(" -> ")}`);
          } else {
            addDependency(importFilePath, location);
          }
          continue;
        }

        addDependency(importFilePath, location);
        fn(importFilePath, newDestination, graph);
      }
    }
  };

  for (const filePath of entryPoints) {
    fn(filePath, "", graph);
  }

  if (!containsCycle) {
    Object.entries(dependencies).forEach(([currentPath, dependencies]) => {
      if (dependencies.length <= 1 || currentPath.includes("..")) {
        return;
      }

      const parent = findSharedParent(dependencies);
      const filename = path.basename(currentPath);
      const currentDir = path.dirname(currentPath);

      const newFilePath = path.join(
        parent,
        "shared",
        path.basename(filename, path.extname(filename)) === "index" &&
          currentDir &&
          currentDir !== "."
          ? path.join(currentDir + path.extname(filename))
          : filename
      );

      changeImportLocation(currentPath, newFilePath);
      // propagate path changes to sub-dependencies
      updateDependencyImportPaths(currentPath, newFilePath);
    });
  }

  const treeKeys = Object.keys(tree);

  if (linkedFiles.size > 0) {
    // const globalTests = [];

    for (const linkedFile of linkedFiles) {
      const sourceFile = linkedFileToOriginal(linkedFile);
      const oneDirUp = path.join(
        path.dirname(sourceFile),
        "..",
        path.basename(sourceFile)
      );
      // source file will either be in the current dir or one up
      let sourceFilePath = tree[sourceFile] || tree[oneDirUp];

      // sometimes the test is add.test.jsx and the source is add.test.js
      // so we have to do a linear search to find source key
      // we could probably optimize this if needed by doing some work in the fn above
      if (!sourceFilePath) {
        const sourceFileWithoutFileExtension = fileWithoutExtension(sourceFile);
        for (const key of treeKeys) {
          if (path.basename(key).startsWith(sourceFileWithoutFileExtension)) {
            sourceFilePath = tree[key];
            break;
          }
        }
      }

      if (!sourceFilePath && isTestFile(linkedFile)) {
        // could not link by filename
        // so the backup is linking by first relative import
        const [firstRelativeImport] = graph[linkedFile];
        if (firstRelativeImport) {
          sourceFilePath = tree[firstRelativeImport];
        }
      }

      if (!sourceFilePath) {
        logger.warn(
          `could not find source file that is linked to ${chalk.blueBright(
            linkedFile
          )} | 2 locations were checked: ${chalk.blueBright(
            sourceFile
          )} and ${chalk.blueBright(oneDirUp)}`
        );
        continue;
      }

      const isSnapshot = linkedFile.endsWith(".snap");

      const location = checkDuplicates(
        path.join(
          path.dirname(sourceFilePath),
          isSnapshot ? "__snapshot__" : "",
          path.basename(linkedFile)
        ),
        path.dirname(sourceFilePath),
        linkedFile
      );

      changeImportLocation(linkedFile, location);
    }
  }

  return tree;
}
