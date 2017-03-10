import astArguments from "./astArguments"
import typeDetails from "./typeDetails"
import gatherFieldSelections from "./gatherFieldSelections"

function traverse({schema, queryAst, info, fieldTypeObj, relation, relationParams, emit, path, selectTypeColumn, filterFragments}){

  let {type: fieldType} = typeDetails(fieldTypeObj),
      sqlConfig = fieldType.sql || fieldType._typeConfig.sql, // TODO: seem like a change graphql 0.8.x and 0.9.x
      sqlConfigFields = (sqlConfig && sqlConfig.fields) || {},
      sqlConfigDeps = (sqlConfig && sqlConfig.deps) || {},
      availableFields = {
        ...Object.keys(fieldType._fields).reduce((memo,e) => ({...memo, [e]: true}), {}),
        ...sqlConfigFields,
        ...Object.keys(sqlConfigDeps).reduce((memo,key) => ({[key]: false}), {}),
      },
      tableAs = fieldType.name.toLowerCase(),
      selectionsAll = gatherFieldSelections(queryAst, info, filterFragments).filter(e => !e.name.value.match(/^__/)),
      selectionsExcluded = selectionsAll.filter(e => !availableFields[e.name.value]),
      selections = selectionsAll.filter(e => availableFields[e.name.value]),
      selectedColumns = []

  if(!sqlConfig)
    throw new Error(`no sql config found for type: ${fieldType.name}; ${path.join(".")}`)

  emit([`select `])

  if(selectTypeColumn){
    emit([`coalesce(to_json(${tableAs}.*) ->> '$type', '${selectTypeColumn}') as "$type" `])
    if(selections.length)
      emit([`, `])
  }

  selections.forEach((e, idx, arr) => {
    let selectionAlias = e.alias && e.alias.value,
        selectionName = e.name.value,
        {type: selectionType, isList: selectionIsList, isObject: selectionIsObject, isInterface: selectionIsInterface, isUnion: selectionIsUnion, isNotNull: selectionIsNotNull} = typeDetails(fieldTypeObj._fields[selectionName].type),
        selectionSqlConfigField = sqlConfigFields[selectionName],
        selectionArgs = astArguments(e, info)

    if(selectionIsObject){
      if(!selectionSqlConfigField)
        throw new Error(`GraphQLObjectType and GraphQLList expects entry in sql config for field: ${selectionName}`)

      let [nextRelation, ...nextRelationParams] = selectionSqlConfigField(selectionArgs, tableAs)

      if(selectionIsNotNull)
        emit([`coalesce(`])

      emit([`(select ${selectionIsList ? "json_agg" : "to_json"}(x) from (`])

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

      if(selectionIsNotNull)
        emit([`, '[]'::json)`])

    } else if(selectionIsInterface||selectionIsUnion) {
      let subTypes = selectionSqlConfigField(selectionArgs, tableAs)

      emit([`(select ${selectionIsList ? "json_agg" : "to_json"}(x) from (`])
      Object.keys(subTypes).forEach((key, idx, arr) => {
        let [subTypeRelation, ...subTypeRelationParams] = subTypes[key],
            obj = schema.getTypeMap()[key]

        emit([`(select to_json(x) as x from (`])

        traverse({
          schema,
          queryAst: e,
          info,
          fieldTypeObj: typeDetails(obj).type,
          relation: subTypeRelation,
          relationParams: subTypeRelationParams,
          emit,
          path: [...path, selectionAlias?`${selectionAlias}:${selectionName}`:selectionName],
          selectTypeColumn: key,
          filterFragments: [key], // TODO proper fragment handling (TBD coalesce(to_json(*) -> 'someField', null) to handle non-existing columns)
        })

        emit([`) x)`])

        if(idx < arr.length - 1)
          emit([` union all `])
      })
      emit([`) x)`])

    } else {
      if(typeof(selectionSqlConfigField)==="function"){
        emit(selectionSqlConfigField(selectionArgs, tableAs))
      }else if(typeof(selectionSqlConfigField) === "string"){
        emit([`${tableAs}.${selectionSqlConfigField}`])
      }else{
        emit([`${tableAs}.${selectionName}`])
      }
    }

    emit([` as "${selectionAlias||selectionName}"`])
    selectedColumns = [...selectedColumns, selectionAlias||selectionName]

    if(idx < arr.length - 1)
      emit([`, `])
  })

  selectionsExcluded.forEach((e,idx) => {
    let deps = (sqlConfigDeps[e.name.value] || [])
      .filter(e => !selectedColumns.includes(e))

    if(deps.length){
      selectedColumns = [...selectedColumns, ...deps]

      // does any sql-based selection exist?
      if((idx === 0 && selections.length) || idx > 0)
        emit([`, `])

      deps.forEach((dep, depIdx) => {
        emit([`${tableAs}.${dep} as "${dep}"`])
        if(depIdx < deps.length - 1)
          emit([`, `])
      })
    }
  })

  emit([` from (${relation}) /*${path.join(".")}*/ as ${tableAs}`, ...relationParams])
}

export default traverse
