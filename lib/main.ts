import {
  Decorator,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Project,
  PropertyDeclaration,
  SourceFile,
  StringLiteral,
  Symbol,
  Type,
} from "ts-morph";
import * as fs from "fs";
import path from "path";
import { readFileSync } from "fs";
import * as R from "ramda";

export type Error = {
  file: string;
  line: number;
  col: number;
  description: string;
  kind: ErrorKind;
  node: Node;
};

type SwaggerAnalyzerOptions = {
  fileIncludePattern: string;
  interactive: boolean;
};

export enum ErrorKind {
  ApiInformationError = 'ApiInformationError',
  ApiParamError = 'ApiParamError',
  ApiPropertyError = 'ApiPropertyError',
}

enum RequestInputType {
  RequestBody = 'body',
  RequestQuery = 'query',
}

type RunOptions = {
  overwrittenFiles: [string, string][];
};

export class SwaggerAnalyzer {
  options: Partial<SwaggerAnalyzerOptions>;
  state: Record<string, Error[]>;
  project: Project;

  private shouldCheckEndpointInformation: boolean;
  private shouldCheckEndpointApiParam: boolean;
  private shouldCheckEndpointRequestBody: boolean;
  private shouldCheckEndpointRequestQuery: boolean;

  constructor(options: Partial<SwaggerAnalyzerOptions>) {
    // Init options
    this.options = options;
    if (!this.options.fileIncludePattern) {
      this.options.fileIncludePattern = `${path.resolve("./")}/${
        this.getConfigField("scopes.file.pathPattern")
      }`;
    }

    this.shouldCheckEndpointInformation = this.getConfigField(
      "scopes.endpoint.information.check",
    );
    this.shouldCheckEndpointApiParam = this.getConfigField(
      "scopes.endpoint.params.check",
    );
    this.shouldCheckEndpointRequestBody = this.getConfigField(
      "scopes.endpoint.body.check",
    );
    this.shouldCheckEndpointRequestQuery = this.getConfigField(
        "scopes.endpoint.query.check",
    );

    // Init state
    this.state = {};
    this.project = new Project();
    this.project.addSourceFilesAtPaths(
      this.options.fileIncludePattern ?? this.options.fileIncludePattern,
    );
  }

  // * Config operations

  externalConfigPath = `${path.resolve("./")}/.swautomaterc`;
  defaultConfigPath = `${__dirname}/config.json`;
  externalConfig = fs.existsSync(this.externalConfigPath)
    ? JSON.parse(readFileSync(this.externalConfigPath, "utf-8"))
    : {};
  internalConfig = JSON.parse(readFileSync(this.defaultConfigPath, "utf-8"));
  CONFIG = R.mergeDeepRight(this.internalConfig, this.externalConfig);

  getConfigField(configPath: string) {
    return this.getObjectOfJson(this.CONFIG, configPath, "");
  }

  getObjectOfJson(jsonObj, path: string, defaultValue: any) {
    return R.path(path.split("."), jsonObj) || defaultValue;
  }

  // * Global stuff

  emit(node: Node, errorText: string, errorKind: ErrorKind) {
    const file = node.getSourceFile();
    const filePath = file.getFilePath();
    const lineInfo = file.getLineAndColumnAtPos(node.getStart());

    if (this.options.interactive) {
      const annotatedPath =
        `file://${filePath}:${lineInfo.line}:${lineInfo.column}`;
      console.log(`${annotatedPath} ${errorText}`);
    }

    const error: Error = {
      file: filePath,
      line: lineInfo.line,
      col: lineInfo.column,
      description: errorText,
      kind: errorKind,
      node,
    };

    const fileErrors = this.state[filePath];
    if (!fileErrors) {
      this.state[filePath] = [error];
    } else {
      fileErrors.push(error);
    }
  }

  clearState() {
    this.state = {};
  }

  run(runOptions?: RunOptions) {
    this.clearState();

    runOptions?.overwrittenFiles?.forEach(([path, content]) => {
      this.project.createSourceFile(path, content, { overwrite: true });
    });

    const controllerFiles = this.getControllerFiles(this.project);

    controllerFiles.forEach((file) => {
      file.getClasses().forEach((clazz) => {
        clazz.getMethods().forEach((method) => {
          if (this.shouldCheckEndpointInformation) {
            this.checkEndpointInformations(method);
          }

          if (this.shouldCheckEndpointRequestBody) {
            this.checkEndpointRequestBody(method);
          }

          if (this.shouldCheckEndpointRequestQuery) {
            this.checkEndpointRequestQuery(method);
          }

          if (this.shouldCheckEndpointApiParam) {
            this.checkEndpointParam(method);
          }

          // endpointHasBasicApiResponse();
          // does decorators include ApiResponse for at least
          // OK and Internal server error?

          // do ApiResponse decorators has correct title and desc
          // with given regex?
        });
      });
    });

    return this.state;
  }

  // * Endpoint informations

  checkEndpointInformations(method: MethodDeclaration) {
    const decorators = method.getDecorators();
    if (!this.hasMethodApiOperationDecorator(method, decorators)) {
      const errorText: string =
        `'${method.getName()}' is endpoint method but it does not have ApiOperation tag to describe endpoint informations`;
      this.emit(method.getNameNode(), errorText, ErrorKind.ApiInformationError);
    }

    if (this.hasMethodApiOperationDecorator(method, decorators)) {
      this.checkInformationProps(method);
    }
  }

  checkEndpointRequestBody(endpointMethod: MethodDeclaration) {
    const payloadParametersOfMethod = endpointMethod.getParameters().filter(
      (parameter) => {
        if (
          this.paramHasGivenDecorator(parameter, "Body") &&
          this.isComplexParam(parameter) && this.hasClassType(parameter)
        ) {
          return parameter;
        }
      },
    );
    payloadParametersOfMethod.map((payloadParam) =>
      this.checkMethodParam(payloadParam, RequestInputType.RequestBody)
    );
  }

  checkEndpointRequestQuery(endpointMethod: MethodDeclaration) {
    const payloadParametersOfMethod = endpointMethod.getParameters().filter(
        (parameter) => {
          if (
              this.paramHasGivenDecorator(parameter, "Query") &&
              this.isComplexParam(parameter) && this.hasClassType(parameter)
          ) {
            return parameter;
          }
        },
    );
    payloadParametersOfMethod.map((payloadParam) =>
        this.checkMethodParam(payloadParam, RequestInputType.RequestQuery)
    );
  }

  checkEndpointParam(endpointMethod: MethodDeclaration) {
    const apiParamParametersOfMethod = endpointMethod.getParameters().filter(
      (methodParameter) => {
        if (this.hasParamDecorator(methodParameter)) {
          return methodParameter;
        }
      },
    );
    apiParamParametersOfMethod.map((apiParamParameter) =>
      this.checkApiParamParameterOfMethod(apiParamParameter, endpointMethod)
    );
  }

  checkInformationProps(method: MethodDeclaration) {
    const apiOperationDec = method.getDecorator("ApiOperation");

    if (this.getConfigField("scopes.endpoint.information.summary.check")){
      this.checkSummary(apiOperationDec);
    }
    if (this.getConfigField("scopes.endpoint.information.description")){
      this.checkDescription(apiOperationDec);
    }
  }

  checkSummary(apiOperationDec: Decorator) {
    if (this.isFieldOfDecoratorNull("summary",apiOperationDec)){
      const errorText = "Endpoint does not have summary text in ApiOperation decorator";
      this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      return;
    }

    const shouldCheckSummaryEmptiness = this.getConfigField(
      "scopes.endpoint.information.summary.checkEmpty",
    );
    const shouldCheckSummaryPattern =
      this.getConfigField("scopes.endpoint.information.summary.pattern") ? true : false;

    if (
      shouldCheckSummaryEmptiness &&
      this.isFieldOfDecoratorEmpty("summary", apiOperationDec)
    ) {
      const errorText = "Summary of endpoint is empty";
      this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      return;
    }

    if (shouldCheckSummaryPattern) {
      const patternRegex = new RegExp(
        `${this.getConfigField("scopes.endpoint.information.summary.pattern")}`,
      );
      if (
        !this.isFieldOfDecoratorMatch("summary", apiOperationDec, patternRegex)
      ) {
        const errorText: string =
          "Summary of endpoint did not match given pattern";
        this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      }
    }
  }

  checkDescription(apiOperationDec: Decorator) {
    if (this.isFieldOfDecoratorNull("description",apiOperationDec)){
      const errorText = "Endpoint does not have description text in ApiOperation decorator";
      this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      return;
    }

    const shouldCheckDescriptionEmptiness = this.getConfigField(
      "scopes.endpoint.information.description.checkEmpty",
    );
    const shouldCheckDescPattern =
      this.getConfigField("scopes.endpoint.information.description.pattern") ? true : false;

    if (
      shouldCheckDescriptionEmptiness &&
      this.isFieldOfDecoratorEmpty("description", apiOperationDec)
    ) {
      const errorText: string = "Description of endpoint is empty";
      this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      return;
    }

    if (shouldCheckDescPattern) {
      const patternRegex = new RegExp(
        `${this.getConfigField("scopes.endpoint.information.description.pattern")}`,
      );
      if (
        !this.isFieldOfDecoratorMatch(
          "description",
          apiOperationDec,
          patternRegex,
        )
      ) {
        const errorText: string =
          "Description of endpoint did not match given pattern";
        this.emit(apiOperationDec, errorText, ErrorKind.ApiInformationError);
      }
    }
  }

  // * Decorator operations

  getPropertiesOfDecorator(decorator: Decorator) {
    const properties = {};
    const argumentObject = decorator.getArguments()[0];
    if (Node.isObjectLiteralExpression(argumentObject)) {
      argumentObject.getProperties().map((property) => {
        if (Node.isPropertyAssignment(property)) {
          const propertyKey = property.getName();
          const propertyValue = property.getInitializer();
          if (Node.isStringLiteral(propertyValue)) {
            properties[propertyKey] = propertyValue.getLiteralValue();
          } else {
            properties[propertyKey] = "NOT_EMPTY";
          }
        }
      });
    }
    return properties;
  }

  isFieldOfDecoratorNull(
    fieldName: string,
    decorator: Decorator,
  ) {
    const decoratorFields = this.getPropertiesOfDecorator(decorator);
    if (decoratorFields[fieldName]) {
      return false;
    }
    return true;
  }

  isFieldOfDecoratorEmpty(
    fieldName: string,
    decorator: Decorator,
  ) {
    const decoratorFields = this.getPropertiesOfDecorator(decorator);
    if (
      !this.isFieldOfDecoratorNull(fieldName, decorator) &&
      decoratorFields[fieldName] === ""
    ) {
      return true;
    }
    return false;
  }

  isFieldOfDecoratorMatch(
    fieldName: string,
    decorator: Decorator,
    pattern: RegExp,
  ) {
    const decoratorFields = this.getPropertiesOfDecorator(decorator);
    const patternRegex = new RegExp(pattern);
    if (
      !this.isFieldOfDecoratorEmpty(fieldName, decorator) &&
      patternRegex.test(decoratorFields[fieldName])
    ) {
      return true;
    }
    return false;
  }

  // * File Operations

  hasFileControllerDecorator(file: SourceFile): boolean {
    let hasFileController = false;
    const classes = file.getClasses();
    classes.forEach((clazz) => {
      const decorators = clazz.getDecorators();
      if (
        decorators.some((decorator) => decorator.getName() === "Controller")
      ) {
        hasFileController = true;
      }
    });
    return hasFileController;
  }

  getControllerFiles(project: Project): SourceFile[] {
    const allFiles = project.getSourceFiles();
    const controllerFiles = allFiles.filter((file) => {
      if (this.hasFileControllerDecorator(file)) {
        return file;
      }
    });
    return controllerFiles;
  }

  // * Parameter operations

  paramHasGivenDecorator(param: ParameterDeclaration, decoratorName: string) {
    if (
      Node.isDecorator(param.getDecorator(decoratorName))
    ) {
      return true;
    }
    return false;
  }

  hasParamDecorator(param: ParameterDeclaration) {
    if (
      Node.isDecorator(param.getDecorator("Param"))
    ) {
      return true;
    }
    return false;
  }

  isComplexParam(param: ParameterDeclaration) {
    if (param.getType().getSymbol()) {
      return true;
    }
    return false;
  }

  hasClassType(param: ParameterDeclaration) {
    if (param.getType().isClass()) {
      return true;
    }
    return false;
  }

  // * Method operations

  checkMethodParam(methodParam: ParameterDeclaration, requestInputType: RequestInputType) {
    const propertiesOfMethodParam = this.getPropertiesOfType(
      methodParam.getType(),
    );
    propertiesOfMethodParam?.map((property) => {
      this.checkProperty(property, requestInputType);
    });
  }

  checkApiParamParameterOfMethod(
    apiParamOfMethod: ParameterDeclaration,
    method: MethodDeclaration,
  ) {
    if (!this.hasMethodApiParamDecorator(method)) {
      const errorText: string =
        `'${method.getName()}' method does not have ApiParam decorator but it has parameter with @Param decorator`;
      this.emit(method.getNameNode(), errorText, ErrorKind.ApiParamError);
      return;
    }

    if (!this.hasMethodApiParamDecoratorForApiParam(method, apiParamOfMethod)) {
      const errorText: string =
        `'${method.getName()}' method does not have ApiParam decorator that matched with '${apiParamOfMethod.getName()}' param`;
      this.emit(apiParamOfMethod.getNameNode(), errorText, ErrorKind.ApiParamError);
      return;
    }

    const matchedApiParamDecorator = this.getMatchedApiParamDecorator(
      method.getDecorators().filter((decorator) =>
        decorator.getName() === "ApiParam"
      ),
      apiParamOfMethod,
    );

    const shouldCheckParamDescription = this.getConfigField(
      "scopes.endpoint.params.description.check",
    );
    if (
      shouldCheckParamDescription &&
      this.isFieldOfDecoratorNull("description", matchedApiParamDecorator)
    ) {
      const errorText: string =
        `ApiParam decorator of '${apiParamOfMethod.getName()}' parameter does not have 'description'`;
      this.emit(matchedApiParamDecorator, errorText, ErrorKind.ApiParamError);
    }

    const paramDescriptionPattern = this.getConfigField(
      "scopes.endpoint.params.description.pattern",
    );
    if (
      paramDescriptionPattern &&
      !this.isFieldOfDecoratorMatch(
        "description",
        matchedApiParamDecorator,
        paramDescriptionPattern,
      )
    ) {
      const errorText: string =
        `'description' in ApiParam decorator of '${apiParamOfMethod.getName()}' parameter did not match with given pattern`;
      this.emit(matchedApiParamDecorator, errorText, ErrorKind.ApiParamError);
    }

    const shouldCheckParamExample = this.getConfigField(
      "scopes.endpoint.params.example.check",
    );
    if (
      shouldCheckParamExample &&
      this.isFieldOfDecoratorNull("example", matchedApiParamDecorator)
    ) {
      const errorText: string =
        `'example' in ApiParam decorator of '${apiParamOfMethod.getName()}' parameter did not match with given pattern`;
      this.emit(matchedApiParamDecorator, errorText, ErrorKind.ApiParamError);
    }
  }

  hasMethodApiOperationDecorator(
    method: MethodDeclaration,
    decorators: Decorator[],
  ): boolean {
    if (
      decorators.some((decorator) => decorator.getName() === "ApiOperation")
    ) {
      return true;
    }
    return false;
  }

  hasMethodApiParamDecorator(
    method: MethodDeclaration,
  ): boolean {
    if (
      method.getDecorators().some((decorator) =>
        decorator.getName() === "ApiParam"
      )
    ) {
      return true;
    }
    return false;
  }

  hasMethodApiParamDecoratorForApiParam(
    method: MethodDeclaration,
    apiParamParameter: ParameterDeclaration,
  ): boolean {
    const apiParamDecorators = method.getDecorators().filter((decorator) =>
      decorator.getName() === "ApiParam"
    );
    if (!apiParamDecorators) {
      return false;
    }

    const matched = this.getMatchedApiParamDecorator(
      apiParamDecorators,
      apiParamParameter,
    );

    if (matched) return true;
    return false;
  }

  getMatchedApiParamDecorator(
    apiParamDecorators: Decorator[],
    apiParamParameter: ParameterDeclaration,
  ) {
    const matched = apiParamDecorators.filter((apiParamDecorator) => {
      const decoratorProperties = this.getPropertiesOfDecorator(
        apiParamDecorator,
      );
      const argumentValueOfApiParam = (apiParamParameter.getDecorator("Param")
        .getArguments()[0] as StringLiteral).getLiteralValue();
      if (decoratorProperties["name"] === argumentValueOfApiParam) {
        return apiParamDecorator;
      }
    });
    return matched[0] ?? undefined;
  }

  // * Property operations

  getPropertyDeclarationOfProperty(property: Symbol) {
    return property
      .getDeclarations()
      .filter((declaration) => Node.isPropertyDeclaration(declaration))[0];
  }

  getDecoratorOfProperty(propertyField: Symbol, decName: string) {
    let decorator: Decorator | undefined;
    propertyField.getDeclarations().map((declaration) => {
      if (Node.isPropertyDeclaration(declaration)) {
        if (declaration.getDecorator(decName)) {
          decorator = declaration.getDecorator(decName);
        }
      }
    });
    return decorator;
  }

  checkProperty(property: Symbol, requestInputType: RequestInputType) {
    const propertyDeclaration = this.getPropertyDeclarationOfProperty(property);

    const doesFieldIsClassProperty = propertyDeclaration !== undefined;
    if (!doesFieldIsClassProperty) {
      return;
    }

    if (
      this.isComplexType(propertyDeclaration.getType()) &&
      !this.isEnumType(propertyDeclaration.getType())
    ) {
      const propertiesOfProperty = this.getPropertiesOfType(
        propertyDeclaration.getType(),
      );
      propertiesOfProperty?.map((property) => this.checkProperty(property, requestInputType));
    }

    this.checkApiPropertyDecoratorOfProperty(property, requestInputType);
  }

  checkApiPropertyDecoratorOfProperty(property: Symbol, requestInputType: RequestInputType) {
    const propertyDeclaration = this.getPropertyDeclarationOfProperty(property);
    const apiPropertyDecorator = this.getDecoratorOfProperty(
      property,
      "ApiProperty",
    );

    if (!apiPropertyDecorator) {
      this.emit(
        propertyDeclaration,
        `The '${
          (propertyDeclaration as PropertyDeclaration).getName()
        }' field does not have ApiProperty tag to describe information's`,
          ErrorKind.ApiPropertyError
      );
      return;
    }

    this.checkApiPropertyDecoratorValuesOfProperty(
      property,
      apiPropertyDecorator,
        requestInputType
    );
  }

  checkApiPropertyDecoratorValuesOfProperty(
    property: Symbol,
    apiPropertyDecorator: Decorator,
    requestInputType: RequestInputType
  ) {
    const checkDesc = this.getConfigField(
      `scopes.endpoint.${requestInputType}.description.check`,
    );
    const checkExample = this.getConfigField(
      `scopes.endpoint.${requestInputType}.example.check`,
    );
    const checkType = this.getConfigField(`scopes.endpoint.${requestInputType}.type.check`);

    const decoratorProperties = this.getPropertiesOfDecorator(
      apiPropertyDecorator,
    );

    if (checkDesc) {
      this.checkDescriptionOfProperty(
        decoratorProperties["description"],
        property,
        apiPropertyDecorator,
          requestInputType
      );
    }

    if (checkExample) {
      this.checkExampleOfProperty(
        decoratorProperties["example"],
        property,
        apiPropertyDecorator,
      );
    }

    if (checkType) {
      this.checkTypeOfProperty(
        decoratorProperties["type"],
        property,
        apiPropertyDecorator,
      );
    }
  }

  checkDescriptionOfProperty(
    description: any,
    field: Symbol,
    decorator: Decorator,
    requestInputType: RequestInputType
  ) {
    if (this.isFieldOfDecoratorNull("description", decorator)) {
      const errorText: string =
        `The '${field.getName()}' field does not have 'description'`;
      this.emit(decorator, errorText, ErrorKind.ApiPropertyError);
      return;
    }

    const pattern = this.getConfigField(
      `scopes.endpoint.${requestInputType}.description.pattern`,
    );

    if (
      pattern &&
      !this.isFieldOfDecoratorMatch("description", decorator, pattern)
    ) {
      const errorText: string =
        `'description' value of '${field.getName()}' field did not match given pattern`;
      this.emit(decorator, errorText, ErrorKind.ApiPropertyError);
    }
  }

  checkExampleOfProperty(
    example: any,
    field: Symbol,
    decorator: Decorator,
  ) {
    if (this.isFieldOfDecoratorNull("example", decorator)) {
      const errorText: string =
        `The '${field.getName()}' field does not have 'example'`;
      this.emit(decorator, errorText, ErrorKind.ApiPropertyError);
    }
  }

  checkTypeOfProperty(_type: any, field: Symbol, decorator: Decorator) {
    if (this.isFieldOfDecoratorNull("type", decorator)) {
      const errorText: string =
        `The '${field.getName()}' field does not have 'type'`;
      this.emit(decorator, errorText, ErrorKind.ApiPropertyError);
    }
  }

  // * Type operations

  isComplexType(type: Type) {
    if (type.isArray()) {
      if (type.getArrayElementType()?.getSymbol()) {
        return true;
      }
    } else if (type.getSymbol()) {
      return true;
    }
    return false;
  }

  isEnumType(type: Type) {
    let isEnum = false;
    type
      .getSymbol()
      ?.getDeclarations()
      .map((d) => {
        if (d.getKindName().includes("Enum")) {
          isEnum = true;
        }
      });
    return isEnum;
  }

  getPropertiesOfType(_type: Type): Symbol[] {
    if (_type.isArray()) {
      _type.getArrayElementType()?.getProperties();
    }
    return _type.getProperties();
  }
}
