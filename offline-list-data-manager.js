  let offlineListDataManager = class OfflineListDataManager {
    
    constructor(databaseName, sortKeyGenerator, listId) {
      this._databaseName = databaseName;
      this._sortKeyGenerator = sortKeyGenerator || this._defaultSortKeyGenerator;
      this._listId = listId || 'default';
      this._localDocId = '_local/list-' + this._listId;
      //TODO: Update method of localDoc initialization
      this._localDoc = {
        _id: this._localDocId,
        content:{
          items: [],
          size: 0
        }
      };
      
      // Map of items by sortKey. e.g {sortKey : full item from db}
      //TODO: Should be byid.
      this._sortByKeyMap = {};
      
      this._setupDB();
    }
    
    /**
     * Used to read page from given startkey
     *
     * @param {number} pageSize - Number of items to be get
     * @param {String} startKey - startkey from where to start read data
     * @return {Promise}
     */
    readPage(pageSize, startKey){
      return new Promise((resolve, reject) => {
        var pageFromLocal = this._readPageFromLocalItems(pageSize, startKey);
        var idsToBeFetch = this._getListOfIdsToBeFetch(pageFromLocal);
        
        this._readPageFromDb(idsToBeFetch).then(response => {
          resolve(response);
        }).catch(function (err) {
          reject(err);
        });
        
      });
    }
    
    /**
     * Used to add/update records in db
     *
     * @param {Array} items - Items to be add or update
     * @param {String} startKey - startkey at where items to add/update
     */
    upsert(items, startKey){
      this._addItemsToDb(items).then(() => {
        this._upsertItemsToLocal(items, startKey);
      });
    }
    
    /**
     * Called on items add/update
     *
     * @param {fn} callbackFn - Function to be called on items changes
     */
    spliceObserver(callbackFn){
      this._spliceCallbackFn = callbackFn;
    }
    
    _readPageFromLocalItems(pageSize, startKey){
      var index = this._localDoc.content.items.findIndex(item => {
        return this._eq(item.sortKey, startKey) >= 0;
      });
      
      var startInx = startKey ? index + 1 : 0;
      return this._localDoc.content.items.slice(startInx, (startInx + pageSize));
    }
    
    _getListOfIdsToBeFetch(localPageData){
      let docIds = [];
      
      localPageData.forEach(item => {
        docIds.push({
          id: item._id,
          sortKey: item.sortKey
        });
      });
      
      return docIds;
    }
    
    _readPageFromDb(docIds){
      return new Promise((resolve, reject) => {
        this.db.bulkGet({
          docs: docIds
        }).then((response) => {
          if(response.results[0].docs[0].error){
            reject(response.results[0].docs[0].error);
            return;
          }
          
          this._onPageReadSuccess(response.results, docIds, resolve);
        }).catch(function (err) {
          reject(err);
        });
      });
    }
    
    _onPageReadSuccess(response, docIds, resolve){
      let responseMap = {};
      
      response.forEach(res => {
        var item = res.docs[0].ok;
        var sortKey = this._sortKeyGenerator(item);
        responseMap[sortKey] = item;
      });
      
      let sortedResponse = [];
      docIds.forEach(item => {
        sortedResponse.push(responseMap[item.sortKey]);
      });
      
      resolve(sortedResponse);
    }
    
    _defaultSortKeyGenerator(item){
      return item._id;
    }
    
    _setupDB(){
      this.db = new PouchDB(this._databaseName);
      this.db.get(this._localDocId).then((response) => {
        this._localDoc = response;
        this._setSortByMap();
      }).catch(() => {
        this._addLocalDocumentToDb();
      });
    }
    
    _setSortByMap(){
      let items = this._localDoc.content.items;
      
      items.forEach(item => {
        this._getDocumnetById(item._id).then(res => {
          delete res._rev;
          this._sortByKeyMap[item.sortKey] = res;
        });
      });
    }
    
    _addLocalDocumentToDb(){
      this.db.post(this._localDoc).catch((err) => {
        console.warn('Local document add operation failed', err);
      });
    }
    
    _addItemsToLocalDoc(localDocitems){
      this.db.get(this._localDocId).then(doc => {
        doc.content.items = localDocitems;
        doc.content.size = localDocitems.length;
        this.db.put(doc).then(() => {
          this._localDoc = doc;
          this._setSortByMap();
        });
      });
    }
    
    _addItemsToDb(items){
      return new Promise((resolve, reject) => {
        items.forEach(item => {
          if(!item._id){
            item._id = item.id.toString();
          }
        });
      
        this.db.bulkDocs(items).then(() => {
          resolve();
        }).catch((err) => {
         console.error('Database add operation failed', err);
        });
      });
    }
    
    _getDocumnetById(id){
      return new Promise((resolve, reject) => {
        this.db.get(id).then(res => {
          resolve(res);
        });
      });
    }
    
    _upsertItemsToLocal(items, startKey){
      var localItems = this._localDoc.content.items;
      var localItemIndex = this._getStartkeyInxInLocalItems(startKey);
      
      //Add items if localItems is not available or if its new page data
      if(!localItems.length || localItemIndex === (localItems.length - 1)){
        var startInx = localItems.length === 0 ? localItemIndex : localItemIndex + 1;
        this._spliceLocalItems(startInx, 0, items, localItems);
        this._addItemsToLocalDoc(localItems);
        return;
      }
      
      this._manageLocalDocItems(items, localItemIndex,localItems);
      this._addItemsToLocalDoc(localItems);
    }
    
    _manageLocalDocItems(items, localItemIndex,localItems){
      items.forEach((item, index) => {
        
        // Add remaing items to local items
        if(localItemIndex >= localItems.length){
          this._spliceLocalItems(localItemIndex, 0, items.slice(index), localItems);
          return;
        }
        
        // compare item with local item
        let itemKey = this._sortKeyGenerator(item);
        let localItemKey = localItems[localItemIndex].sortKey;
        let comparatorValue = this._eq(itemKey, localItemKey);
        
        if(comparatorValue > 0){
          this._removeDuplicateKey(localItems, itemKey);
          this._spliceLocalItems(localItemIndex, 0, item, localItems);
          localItemIndex++;
          return;
        }
        
        if(comparatorValue < 0){
          this._spliceLocalItems(localItemIndex, 1, localItems);
          return;
        }
        
        // Update value if it's not same by value
        let localItem = localItems[localItemIndex];
        if(this._eq(this._sortByKeyMap[localItem.sortKey], item) !== 0){
//          localItems[localItemIndex] = item;
          this._spliceCallbackFn && this._spliceCallbackFn(localItemIndex, 0, []);
        }
        
        localItemIndex++;
      });
    }
    
    _getStartkeyInxInLocalItems(startKey){
      var localItemIndex = this._localDoc.content.items.findIndex(item => {
        return this._eq(item.sortKey, startKey) >= 0;
      });
      
      return localItemIndex === -1 ? 0 : localItemIndex;
    }
    
    _spliceLocalItems(startIndex, removedCount, itemToBeAdd, array){
      let items = Array.isArray(itemToBeAdd) ? itemToBeAdd : [itemToBeAdd];
      
      if(removedCount){
        array.splice(index,removedCount);
      }
      
      if(items.length){
        items.forEach(item => {
          this._addItemToLocalDoc(startIndex, item, array);
          startIndex++;
        });
      }
      
      this._spliceCallbackFn && this._spliceCallbackFn(startIndex, removedCount, itemToBeAdd);
      
      if(this._localDoc.content.size !== array.length){
        this._localDoc.content.size = array.length;
      }
    }
    
    _addItemToLocalDoc(index, item, array){
      if(!item){
        return;
      }
      
      let id = item._id || item.id;
      let obj = {
        _id: id.toString(),
        sortKey: this._sortKeyGenerator(item)
      };
      
      array.splice(index, 0, obj);
    }
    
    _removeDuplicateKey(items, key){
      var index = items.findIndex(item => {
        return this._sortKeyGenerator(item) === key
      });
      
      if(index !== -1){
         this._spliceLocalItems(index, 1, items);
      }
    }
    
    _eq(a, b) {
      if (a === b) {
        return 0;
      }

      a = this._normalizeKey(a);
      b = this._normalizeKey(b);

      var ai = this.collationIndex(a);
      var bi = this.collationIndex(b);
      
      if ((ai - bi) !== 0) {
        return ai - bi;
      }
      
      if (a === null) {
        return 0;
      }
      
      switch (typeof a) {
        case 'number':
          return a - b;
        case 'boolean':
          return a === b ? 0 : (a < b ? -1 : 1);
        case 'string':
          return this._stringCollate(a, b);
      }
      
      return Array.isArray(a) ? this._arrayCollate(a, b) : this._objectCollate(a, b);
    }

    _normalizeKey(key) {
      switch (typeof key) {
        case 'undefined':
          return null;
        case 'number':
          if (key === Infinity || key === -Infinity || isNaN(key)) {
            return null;
          }
          return key;
        case 'object':
          var origKey = key;
          if (Array.isArray(key)) {
            var len = key.length;
            key = new Array(len);
            for (var i = 0; i < len; i++) {
              key[i] = this._normalizeKey(origKey[i]);
            }
         
          } else if (key instanceof Date) {
            return key.toJSON();
          } else if (key !== null) { 
            key = {};
            for (var k in origKey) {
              if (origKey.hasOwnProperty(k)) {
                var val = origKey[k];
                if (typeof val !== 'undefined') {
                  key[k] = this._normalizeKey(val);
                }
              }
            }
          }
      }
      return key;
    }

    _arrayCollate(a, b) {
      var len = Math.min(a.length, b.length);
      
      for (var i = 0; i < len; i++) {
        var sort = this._eq(a[i], b[i]);
        if (sort !== 0) {
          return sort;
        }
      }
      
      return (a.length === b.length) ? 0 : (a.length > b.length) ? 1 : -1;
    }
    
    _stringCollate(a, b) {
      return (a === b) ? 0 : ((a > b) ? 1 : -1);
    }
    
    _objectCollate(a, b) {
      var ak = Object.keys(a), bk = Object.keys(b);
      var len = Math.min(ak.length, bk.length);
      
      for (var i = 0; i < len; i++) {

        var sort = this._eq(ak[i], bk[i]);
        
        if (sort !== 0) {
          return sort;
        }
        
        sort = this._eq(a[ak[i]], b[bk[i]]);
        if (sort !== 0) {
          return sort;
        }

      }
      return (ak.length === bk.length) ? 0 :
        (ak.length > bk.length) ? 1 : -1;
    }

    collationIndex(x) {
      var id = ['boolean', 'number', 'string', 'object'];
      var idx = id.indexOf(typeof x);
     
      if (~idx) {
        if (x === null) {
          return 1;
        }
        if (Array.isArray(x)) {
          return 5;
        }
        return idx < 3 ? (idx + 2) : (idx + 3);
      }

      if (Array.isArray(x)) {
        return 5;
      }
    }
    
  }
