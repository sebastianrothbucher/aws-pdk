/*! Copyright [Amazon.com](http://amazon.com/), Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0 */
import * as path from "path";
import { ProjectUtils } from "@aws/monorepo";
import { DependencyType } from "projen";
import { JavaProject } from "projen/lib/java";
import {
  CodeGenerationSourceOptions,
  GeneratedJavaInfrastructureOptions,
} from "../../../types";
import { OpenApiGeneratorHandlebarsIgnoreFile } from "../../components/open-api-generator-handlebars-ignore-file";
import { OpenApiGeneratorIgnoreFile } from "../../components/open-api-generator-ignore-file";
import { OpenApiToolsJsonFile } from "../../components/open-api-tools-json-file";
import { TypeSafeApiCommandEnvironment } from "../../components/type-safe-api-command-environment";
import {
  buildCleanOpenApiGeneratedCodeCommand,
  buildInvokeMockDataGeneratorCommand,
  buildInvokeOpenApiGeneratorCommandArgs,
  buildTypeSafeApiExecCommand,
  getHandlersProjectVendorExtensions,
  OtherGenerators,
  TypeSafeApiScript,
} from "../../components/utils";
import { GeneratedHandlersProjects } from "../../generate";
import { GeneratedJavaRuntimeProject } from "../../runtime/generated-java-runtime-project";

export interface GeneratedJavaCdkInfrastructureProjectOptions
  extends GeneratedJavaInfrastructureOptions,
    CodeGenerationSourceOptions {
  /**
   * The generated java types
   */
  readonly generatedJavaTypes: GeneratedJavaRuntimeProject;
  /**
   * Generated handlers projects
   */
  readonly generatedHandlers: GeneratedHandlersProjects;
}

export class GeneratedJavaCdkInfrastructureProject extends JavaProject {
  /**
   * Options configured for the project
   * @private
   */
  private readonly options: GeneratedJavaCdkInfrastructureProjectOptions;

  /**
   * Source directory
   * @private
   */
  private readonly srcDir: string;

  /**
   * Java package name
   * @private
   */
  private readonly packageName: string;

  constructor(options: GeneratedJavaCdkInfrastructureProjectOptions) {
    super({
      ...(options as any),
      sample: false,
      junit: false,
    });
    TypeSafeApiCommandEnvironment.ensure(this);

    this.options = options;
    this.packageName = `${this.pom.groupId}.${this.name}.infra`;
    this.srcDir = path.join(
      "src",
      "main",
      "java",
      ...this.packageName.split(".")
    );

    [
      `software.aws/pdk@${ProjectUtils.getPdkVersion()}`,
      "software.constructs/constructs@10.3.0",
      "software.amazon.awscdk/aws-cdk-lib@2.133.0",
      "io.github.cdklabs/cdknag@2.28.60",
      "org.projectlombok/lombok@1.18.30",
      "com.fasterxml.jackson.core/jackson-databind@2.17.0",
      `io.github.cdklabs/projen@0.80.10`,
      `${options.generatedJavaTypes.pom.groupId}/${options.generatedJavaTypes.pom.artifactId}@${options.generatedJavaTypes.pom.version}`,
    ]
      .filter(
        (dep) =>
          !this.deps.tryGetDependency(dep.split("@")[0], DependencyType.RUNTIME)
      )
      .forEach((dep) => this.addDependency(dep));

    // Pin constructs version
    this.deps.removeDependency(
      "software.constructs/constructs",
      DependencyType.BUILD
    );
    this.addDependency("software.constructs/constructs@10.3.0");

    // Remove the projen test dependency since otherwise it takes precedence, causing projen to be unavailable at synth time
    this.deps.removeDependency("io.github.cdklabs/projen", DependencyType.TEST);

    // Add a dependency on the generated java types repository
    this.pom.addRepository({
      url: `file://${path.relative(
        this.outdir,
        options.generatedJavaTypes.outdir
      )}/dist/java`,
      id: `${options.generatedJavaTypes.pom.groupId}-${options.generatedJavaTypes.pom.artifactId}-repo`,
    });

    // Ignore everything but the target files
    const openapiGeneratorIgnore = new OpenApiGeneratorIgnoreFile(this);
    openapiGeneratorIgnore.addPatterns(
      "/*",
      "**/*",
      "*",
      `!${this.srcDir}/Api.java`,
      `!${this.srcDir}/ApiProps.java`,
      `!${this.srcDir}/MockIntegrations.java`
    );

    const openapiGeneratorHandlebarsIgnore =
      new OpenApiGeneratorHandlebarsIgnoreFile(this);
    openapiGeneratorHandlebarsIgnore.addPatterns(
      "/*",
      "**/*",
      "*",
      `!${this.srcDir}/__functions.java`
    );

    // Add OpenAPI Generator cli configuration
    OpenApiToolsJsonFile.ensure(this).addOpenApiGeneratorCliConfig(
      options.openApiGeneratorCliConfig
    );

    const generateTask = this.addTask("generate");
    generateTask.exec(buildCleanOpenApiGeneratedCodeCommand());
    generateTask.exec(
      buildTypeSafeApiExecCommand(
        TypeSafeApiScript.GENERATE,
        this.buildGenerateCommandArgs()
      )
    );
    // Copy the parsed spec into the resources directory so that it's included in the jar
    generateTask.exec("mkdir -p src/main/resources");
    generateTask.exec(
      `cp -f ${this.options.specPath} src/main/resources/.api.json`
    );
    // Absolute path of this project is required for determining the path to the handlers jar,
    // since java executes from the jar which could be anywhere in the filesystem (eg the .m2 directory).
    // While ugly, since this is written at build time and not checked in it remains portable.
    generateTask.exec(
      "echo $(pwd) > src/main/resources/project-absolute-path.txt"
    );

    if (!this.options.mockDataOptions?.disable) {
      generateTask.exec(this.buildGenerateMockDataCommand());
    }

    this.preCompileTask.spawn(generateTask);

    // Ignore the generated code
    this.gitignore.addPatterns("src", ".openapi-generator");
  }

  public buildGenerateCommandArgs = () => {
    return buildInvokeOpenApiGeneratorCommandArgs({
      generator: "java",
      specPath: this.options.specPath,
      generatorDirectory: OtherGenerators.JAVA_CDK_INFRASTRUCTURE,
      srcDir: this.srcDir,
      normalizers: {
        KEEP_ONLY_FIRST_TAG_IN_OPERATION: true,
      },
      extraVendorExtensions: {
        "x-infrastructure-package": this.packageName,
        "x-runtime-package": this.options.generatedJavaTypes.packageName,
        // Enable mock integration generation by default
        "x-enable-mock-integrations": !this.options.mockDataOptions?.disable,
        ...getHandlersProjectVendorExtensions(
          this,
          this.options.generatedHandlers
        ),
      },
      // Do not generate map/list types. Generator will use built in HashMap, ArrayList instead
      generateAliasAsModel: false,
    });
  };

  public buildGenerateMockDataCommand = (): string => {
    return buildInvokeMockDataGeneratorCommand({
      specPath: this.options.specPath,
      // Write the mocks to the resources directory
      outputSubDir: "src/main/resources",
      ...this.options.mockDataOptions,
    });
  };
}
