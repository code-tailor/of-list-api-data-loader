class OfflineListDataManager {

  constructor(databaseName, sortKeyGenerator, listId) {
    this._sortKeyGenerator = sortKeyGenerator || this._defaultSortKeyGenerator;
    this._comparator = new Comparator();
    this._localStore = new LocalStore(databaseName, listId);
    //offline items. key=id, value=item. It's retrieved from the local store.
    this._items = {};
  }


  /**
   * Used to read page from given startkey
   *
   * @param {number} pageSize - Number of items to be retrieve
   * @param {String} startKey - startkey from where to start read data. It's optional, when want to read firstData, it won't be available.
   * @return {Promise}
   */
  readPage(pageSize, startKey) {
    return new Promise((resolve, reject) => {
      this._init().then(() => {
        var itemIds = this._readItemIdsFromLocalDoc(pageSize, startKey);
        let items = this._readItems(itemIds);
        resolve({
          items: items
        });
        let localItemIndex = this._findItemIndex(startKey);
        this._spliceCallbackFn && this._spliceCallbackFn(localItemIndex, 0, ...items);
      }).catch(reject);
    });
  }

  /**
   * Used to add/update records in db
   *
   * @param {Array} items - Items to be add or update
   * @param {String} startKey - startkey at where items to add/update
   * @param {Boolean} eol - Whether this is end-of-list or not.
   */
  upsert(items, startKey, eol) {
    return this._init().then(() => {
      var localItems = this._localDoc.items;
      var localItemIndex = this._findItemIndex(startKey);


      for (var index = 0; index < items.length; index++) {

        // Add remaing items to local items
        if (localItemIndex >= localItems.length) {
          items.slice(index).forEach(item => {
            this._upsertItem(item);
          });
          this._spliceLocalItems(localItemIndex, 0, items.slice(index));
          break;
        }

        // compare item with local item
        var localItem = localItems[localItemIndex];
        let comparatorValue = this._compareItems(items[index], this._items[localItem.id]);
        
        if (comparatorValue < 0) {
          //prepend this item to localItems.
          this._upsertItem(items[index]);
          this._spliceLocalItems(localItemIndex, 0, items[index]);
          //Remove this items duplicate instance if any
          this._removeFromLocalItems(items[index]._id, localItemIndex+1);
          localItemIndex++;
        }

        if (comparatorValue > 0) {
          //remove this local item.
          this._removeItem(localItems[localItemIndex]);
          this._spliceLocalItems(localItemIndex, 1);
        }
        
        if((index + 1) === items.length){
          this._deleteRemaingItems(localItemIndex + 1);
        }
        
        //TODO: Update item if it's updated by value.
        localItemIndex++;
      }

      this._saveLocalDoc();
    });
  }

  /**
   * Called on items add/update
   *
   * @param {fn} callbackFn - Function to be called on items changes
   */
  spliceObserver(callbackFn) {
    this._spliceCallbackFn = callbackFn;
  }


  _init() {
    return new Promise((resolve, reject) => {
      this._localStore.readListDoc().then((listDoc) => {
        this._localDoc = listDoc;
        
        // Load all items.
        var docIds = this._localDoc.items.map(item => {
          return {id: item.id}
        });
        
        if(!docIds.length){
          resolve();
          return;
        }
        
        this._localStore.readItems(docIds).then(results => {
          results.forEach(item => {
            if(item){
               this._items[item._id] = item;
            }
          });
          resolve();
        });
        
      });
    });
  }

  _compare(k1, k2) {
    return this._comparator.compare(k1, k2);
  }

  _compareItems(item1, item2) {
    let key1 = this._sortKeyGenerator(item1), key2 = this._sortKeyGenerator(item2);
    return this._compare(key1, key2);
  }

  _readItems(itemids) {
    return itemids.map((id) => {
      return this._items[id];
    });
  }

  /**
   * If item exists in `_items`, does nothing. Otherwise, saves there and into LocalStore as well.
   * Future enhancement, it will check for update of the content as well. If content has been updated, updates `_items`
   * and LocalStore both.
   * @param {*} item 
   * @returns {Boolean} `true` if given item is inserted or updated.
   */
  _upsertItem(item) {
    if(this._items[item.id]){
      return false;
    }
    
    this._items[item._id] = item;
    this._localStore.upsertItems([item]);
    
    return true;
  }


  _removeItem(item) {
    delete this._items[item.id];
    this._localStore.removeItems([item.id]);
  }

  _saveLocalDoc(){
    this._localStore.saveListDoc(this._localDoc);
  }

  _removeFromLocalItems(id, startIndex) {
    var items = this._localDoc.items;
    for(var i=startIndex; i++; i < items.length) {
      if(!items[i]){
        return;
      }
      
      if(items[i].id === id) {
        this._spliceLocalItems(i, 1);
        break;
      }
    }
  }


  /**
   * Finds localItems whose sortKey is >= to `sortKey`. Returns that item's index if sortKey is greater, 
   * othewise +1 index. Returns last-item's index if item isn't found.
   * 
   * @param {*} sortKey 
   */
  _findItemIndex(sortKey) {
    let items = this._localDoc.items;
    let index = items.findIndex(item => {
      return this._compare(item.sortKey, sortKey) <= 0;
    });

    if (index == -1) {
      return 0;
    }

    if (this._compare(items[index].sortKey, sortKey) == 0) {
      index++;
    }

    //This is needed if sortKey matches to last item.
    return Math.min(index, items.length);
  }

  _readItemIdsFromLocalDoc(pageSize, startKey) {
    let index = this._findItemIndex(startKey);
    return this._localDoc.items.slice(index, Math.min(this._localDoc.items.length, index + pageSize)).map((item) => {
      return item.id;
    });
  }
  
  _deleteRemaingItems(index){
    let localItems = [...this._localDoc.items];
    let itemsToBeDelete = localItems.slice(index);
    this._spliceLocalItems(index, itemsToBeDelete.length);
  }

  _defaultSortKeyGenerator(item) {
    return item._id;
  }

  _toArray(items) {
    if(Array.isArray(items)) {
      return items;
    }
    if(!items)
      return [];

    return [items];
  }


  _spliceLocalItems(startIndex, removedCount, newItems) {
    let localItems = this._localDoc.items;
    newItems = this._toArray(newItems);
    
    
    let newLocalItems = newItems.map((item)=>{
      return {
        id: item._id,
        sortKey: this._sortKeyGenerator(item)
      };
    });
    localItems.splice(startIndex, removedCount, ...newLocalItems);
    this._spliceCallbackFn && this._spliceCallbackFn(startIndex, removedCount, ...newItems);
  }

}


// Class to compare two values
class Comparator {

  compare(a, b) {
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
      var sort = this.compare(a[i], b[i]);
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

      var sort = this.compare(ak[i], bk[i]);

      if (sort !== 0) {
        return sort;
      }

      sort = this.compare(a[ak[i]], b[bk[i]]);
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


//Performs pouchdb operations
class LocalStore {
  constructor(dbName, listId) {
    this._dbName = dbName;
    this._listId = listId || 'default';
    this._localDocId = '_local/list-' + this._listId;
    this.db = new PouchDB(this._dbName);
  }

  readListDoc() {
    return new Promise((resolve, reject) => {
      this.db.get(this._localDocId).then((doc) => {
        resolve(doc);
      }).catch(() => {
        let doc = {
          _id: this._localDocId,
          items: [],
        };
        resolve(doc);
        this.db.post(doc).catch((err) => {
          console.warn('Failed to create local doc for list. db=' + this._dbName + ' listId=' + this._listId, err);
        });
      });
    });
  }

  saveListDoc(doc) {
    return this.db.get(doc._id).then((res) => {
      doc._rev = res._rev;
      this.db.put(doc);
    });
  }

  readItems(docIds) {
    return new Promise((resolve, reject) => {
      this.db.bulkGet({
        docs: docIds
      }).then((response) => {
        if (response.results[0].docs[0].error) {
          reject(response.results[0].docs[0].error);
          return;
        }

        resolve(this._sortById(response.results, docIds));
      }).catch(function (err) {
        reject(err);
      });
    });
  }

  upsertItems(items) {
    this.db.bulkDocs(items).catch((err) => {
     console.error('Failed to upsert items in db. db name:' + this._dbName, err);
    });
  }

  removeItems(itemIds) {
    itemIds.forEach(id => {
      this.db.get(id).then((doc) => {
        return this.db.remove(doc);
      }).catch((err) => {
        console.warn('Failed to delete document. db name' + this._dbName + ' docId=' + id, err);
      });
    })
  }

  _sortById(response, docIds) {
    let responseMap = {};

    response.forEach(res => {
      var item = res.docs[0].ok;
      if(!item){
        return;
      }
      responseMap[item._id] = item;
    });

    let sortedResponse = [];
    docIds.forEach(item => {
      sortedResponse.push(responseMap[item.id]);
    });
    return sortedResponse;
  }


  _addItemsToDb(items) {
    return new Promise((resolve, reject) => {
      this.db.bulkDocs(items).then(() => {
        resolve();
      }).catch((err) => {
        console.error('Database add operation failed', err);
      });
    });
  }
}
