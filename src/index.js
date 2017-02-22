function sqlAliasAwareFieldResolver(origResolve, obj, args, ctx, info){
  let ast = info.fieldNodes[0],
      key = ast.alias ? ast.alias.value : ast.name.value,
      res = obj[key]

  if(res === undefined)
    res = origResolve(obj, args, ctx, info)

  return res
}

export function createSqlResolve(schemaFn, fetchRows){
  return (fn) => {
    return (obj,args,ctx,info) => {
      return simpleResolve(fn(obj,args,ctx,info), schemaFn(), info, fetchRows)
    }
  }
}


export function sqlAliasAwareResolvers(schema){
  return Object
    .keys(schema.getTypeMap())
    .map(e => schema.getTypeMap()[e])
    .filter(e => e.constructor.name === "GraphQLObjectType")
    .filter(e => !e.name.match(/^__/))
    .filter(e => ![
      schema.getQueryType(),
      schema.getMutationType(),
      schema.getSubscriptionType()
    ].includes(e))
    .reduce((memo, type) => {
      return {
        ...memo,
        [type.name]: Object.keys(type._fields).reduce((memo, key) => {
          return {...memo, [key]: sqlAliasAwareFieldResolver.bind(null, type._fields[key].resolve)}
        }, {})
      }
    }, {})
}

export function simpleResolveSQLParts([relation,...relationParams], schema, info){
  const queryAst = info.fieldNodes[0]

  let parts = [],
      emit = (part) => {
        parts = [...parts, part]
      },
      path = [queryAst.name.value]

  let fieldType = typeDetails(info.returnType)

  traverse({
    schema,
    queryAst,
    info,
    fieldTypeObj: fieldType.type,
    relation,
    relationParams,
    emit,
    path,
    selectTypeColumn: false,
    filterFragments: [],
  })

  let sql = parts.map(([sql]) => sql).join(""),
      params = parts.reduce((memo, [sql,...params]) => [...memo, ...params], [])

  return {sql,params}
}

export function simpleResolve([relation,...relationParams], schema, info, fetchRows){
  let {sql,params} = simpleResolveSQLParts([relation,...relationParams], schema, info),
      fieldType = typeDetails(info.returnType)

  return fetchRows(sql,params).then(res => {
    if(Array.isArray(res)){
      if(!fieldType.isList)
      return res[0]
    }

    return res
  })
}

function typeDetails(type){
  let isList = false,
      isNotNull = false

  if(type.constructor.name === "GraphQLNonNull"){
    isNotNull = true
    type = type.ofType
  }

  if(type.constructor.name === "GraphQLList"){
    isList = true
    type = type.ofType
  }

  let isObject = (type.constructor.name === "GraphQLObjectType"),
      isInterface = (type.constructor.name === "GraphQLInterfaceType"),
      isUnion = (type.constructor.name === "GraphQLUnionType")

  return {type, isList, isNotNull, isObject, isInterface, isUnion}
}

function gatherFieldSelections(ast, info, filterFragments){
  let fields = ast
    .selectionSet
    .selections
    .filter(e => e.kind === "Field")

  fields = ast
    .selectionSet
    .selections
    .filter(e => e.kind === "FragmentSpread")
    .map(e => info.fragments[e.name.value])
    .reduce((memo, fragment) => {
      return [
        ...memo,
        ...gatherFieldSelections(fragment, info, filterFragments),
      ]
    }, fields)

  fields = ast
    .selectionSet
    .selections
    .filter(e => e.kind === "InlineFragment")
    .filter(e => filterFragments.length === 0 || filterFragments.includes(e.typeCondition.name.value))
    .reduce((memo, fragment) => {
      return [
        ...memo,
        ...gatherFieldSelections(fragment, info, filterFragments),
      ]
    }, fields)

  return fields
}

function traverse({schema, queryAst, info, fieldTypeObj, relation, relationParams, emit, path, selectTypeColumn, filterFragments}){

  let {type: fieldType} = typeDetails(fieldTypeObj),
      args = astArguments(queryAst, info),
      tableLookup = fieldType.sql,
      tableFields = (tableLookup && tableLookup.fields) || {}

  if(!tableLookup)
    throw new Error(`no tableFn found for type: ${fieldType.name}; ${path.join(".")}`)

  let defaultFields = Object
    .keys(fieldType._fields)
    .reduce((memo,e) => ({...memo, [e]: true}), {})

  let availableFields = {
    ...defaultFields,
    ...tableFields,
  }


  let tableAs = fieldType.name.toLowerCase(),
      selectionsAll = gatherFieldSelections(queryAst, info, filterFragments).filter(e => !e.name.value.match(/^__/)),
      selectionsExcluded = selectionsAll.filter(e => !availableFields[e.name.value]),
      selections = selectionsAll.filter(e => availableFields[e.name.value])

  emit([`select `])

  if(selectTypeColumn){
    emit([` ${tableAs}."$type"`])
    if(selections.length)
      emit([`, `])
  }

  selections.forEach((e, idx, arr) => {
    let selectionAlias = e.alias && e.alias.value,
        selectionName = e.name.value

    // console.info(">>", selectionName, fieldTypeObj, fieldTypeObj._fields[selectionName])

    let {type: selectionType, isList: selectionIsList, isObject: selectionIsObject, isInterface: selectionIsInterface, isUnion: selectionIsUnion} = typeDetails(fieldTypeObj._fields[selectionName].type),
        fieldLookup = (tableLookup.fields||{})[selectionName],
        selectionArgs = astArguments(e, info)

    if(selectionIsObject){
      if(!fieldLookup)
        throw new Error(`GraphQLObjectType and GraphQLList expects fieldLookup: ${selectionName}`)

      let [nextRelation, ...nextRelationParams] = fieldLookup(selectionArgs, tableAs),
          jsonFn = selectionIsList ? "json_agg" : "to_json"

      emit([`(select ${jsonFn}(x) from (`])


      traverse({
        schema,
        queryAst: e,
        info,
        fieldTypeObj: selectionType,
        relation: nextRelation,
        relationParams: nextRelationParams,
        emit,
        path: [...path, selectionAlias?`${selectionAlias}:${selectionName}`:selectionName],
        selectTypeColumn: false,
        filterFragments: [],
      })

      emit([`) x)`])
    } else if(selectionIsInterface||selectionIsUnion) {
      let subTypes = fieldLookup(selectionArgs, tableAs),
          jsonFn = selectionIsList ? "json_agg" : "to_json"

      emit([`(select ${jsonFn}(x) from (`])
      Object.keys(subTypes).forEach((key, idx, arr) => {
        let [subTypeRelation, ...subTypeRelationParams] = subTypes[key]

        emit([`(select to_json(x) as x from (`])

        let obj = schema.getTypeMap()[key]

        traverse({
          schema,
          queryAst: e,
          info,
          fieldTypeObj: typeDetails(obj).type,
          relation: subTypeRelation,
          relationParams: subTypeRelationParams,
          emit,
          path: [...path, selectionAlias?`${selectionAlias}:${selectionName}`:selectionName],
          selectTypeColumn: true,
          filterFragments: [key], // TODO proper fragment handling (TBD coalesce(to_json(*) -> 'someField', null) to handle non-existing columns)
        })

        emit([`) x)`])

        if(idx < arr.length - 1)
          emit([` union all `])
      })
      emit([`) x)`])

    } else {
      emit(typeof(fieldLookup)==="function" ? fieldLookup(selectionArgs, tableAs) : [`${tableAs}.${selectionName}`])
    }

    emit([` as "${selectionAlias||selectionName}"`])

    if(idx < arr.length - 1)
      emit([`, `])
  })

  selectionsExcluded.forEach((e, idx, arr) => {
    let selectionName = e.name.value,
        depsFn = (tableLookup.deps||{})[selectionName],
        selectionArgs = astArguments(e, info),
        deps = depsFn ? depsFn(selectionArgs, tableAs) : {},
        depKeys = Object.keys(deps)

    // prevent duplicate columns
    deps = depKeys.reduce((memo, depKey) => {
      // dependency already exist in selection of query
      if(selections.find(e => e.name.value === depKey))
        return memo

      // add dependency
      return {
        ...memo,
        [depKey]: deps[depKey]
      }
    }, {})

    depKeys = Object.keys(deps)

    if(depKeys.length){

      // does any sql-based selection exist?
      if(selections.length)
        emit([`, `])

      depKeys.forEach((depKey, depIdx, depArr) => {
        let [depExpr,...depParams] = deps[depKey]

        emit([`${depExpr} as "${depKey}"`, ...depParams])

        if(depIdx < depArr.length - 1)
          emit([`, `])
      })

      if(idx < arr.length - 1)
        emit([`, `])
    }


  })

  emit([` from (${relation}) /*${path.join(".")}*/ as ${tableAs}`, ...relationParams])
}

function astArguments(ast, info){
  return ast.arguments.reduce((memo,e) => ({
    ...memo,
    [e.name.value]: convertArgValue(e.value, info),
  }), {})
}

export function parseArgValue({kind,value}){
  switch(kind){
    case "IntValue":
      return parseInt(value, 10)
    case "FloatValue":
      return parseFloat(value)
    case "StringValue":
      return value
    default:
      throw new Error(`unsupported argument kind: ${kind}`)
  }
}

function convertArgValue(e, info){
  const {kind} = e
  switch(kind){
    case "Variable":
      return info.variableValues[e.name.value]
    case "IntValue":
    case "FloatValue":
    case "StringValue":
      return parseArgValue(e)
    default:
      throw new Error(`unsupported argument kind: ${kind}`)
  }
}
