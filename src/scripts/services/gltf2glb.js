/**
 * Based on makeglb by Saurabh Bhatia
 * https://github.com/sbtron/makeglb
 * The MIT License
 * Copyright (c) 2017 Saurabh Bhatia
 */

/** @constant {number} FILE_HEADER_SIZE GLB file header size. */
const FILE_HEADER_SIZE = 12;

/** @constant {number} JSON_CHUNK_HEADER_SIZE GLB file json chunk header size. */
const JSON_CHUNK_HEADER_SIZE = 8;

/** @constant {number} GLTF_VERSION GLTF version. */
const GLTF_VERSION = 2;

/** @constant {number} BIN_CHUNK_HEADER_SIZE GLB file bin chunk header size. */
const BIN_CHUNK_HEADER_SIZE = 8;

/** @constant {number} BUFFER_INDEX_INCREMENT Buffer index increment. */
const BUFFER_INDEX_INCREMENT = 4;

/** @constant {number} GLTF_HEADER GLTF header marker. */
const GLTF_HEADER = 0x46546C67;

/** @constant {number} CHUNK_JSON JSON chunk marker. */
const CHUNK_JSON = 0x4E4F534A;

/** @constant {number} CHUNK_BIN BIN chunk marker. */
const CHUNK_BIN = 0x004E4942;

/** @constant {number} JSON_PADDING JSON padding. */
const JSON_PADDING = 0x20;

class threeDModelGLTF2GLB {
  /**
   * @class H5PEditor.threeDModelGLTF2GLB
   */
  constructor() {
    this.remainingFilesToProcess = 0;
    this.files = [];
    this.fileblobs = [];
    this.glbfilename;
    this.gltf;
    this.outputBuffers;
    this.bufferMap;
    this.bufferOffset;
    this.gltfMimeTypes = {
      'image/png': ['png'],
      'image/jpeg': ['jpg', 'jpeg'],
      'text/plain': ['glsl', 'vert', 'vs', 'frag', 'fs', 'txt'],
      'image/vnd-ms.dds': ['dds']
    };
  }

  /**
   * Convert items to single glb file.
   * @param {object[]} items Items.
   * @param {function} callback Callback when done, will return file or error.
   */
  convert(items, callback) {
    if (!items || typeof callback !== 'function') {
      return;
    }

    this.callback = callback;

    this.remainingFilesToProcess = items.length;

    for (let i = 0; i < items.length; i++) {
      let entry;
      if (items[i].getAsEntry) {
        entry = items[i].getAsEntry();
      }
      else if (items[i].webkitGetAsEntry) {
        entry = items[i].webkitGetAsEntry();
      }

      if (entry) {
        if (entry.isFile) {
          callback({
            error: H5PEditor.t('H5PEditor.ThreeDModel', 'notAFolder')
          });
          return;
        }

        this.traverseFileTree(entry);
      }
    }
  }

  /**
   * Traverse all files in folder.
   * @param {object} item File or folder.
   * @param {string} path Current path.
   */
  traverseFileTree(item, path = '') {
    if (item.isFile) {
      item.file((file) => {
        this.files.push(file);

        const extension = file.name.split('.').pop();
        if (extension === 'gltf') {
          const lastSlashIndex = file.name.lastIndexOf('/') + 1;
          const lastDotIndex = file.name.lastIndexOf('.');
          this.glbfilename = file.name.substring(lastSlashIndex, lastDotIndex);

          const reader = new FileReader();
          reader.readAsText(file);
          reader.onload = (event) => {
            this.gltf = JSON.parse(event.target.result);
            this.checkForDone();
          };
        }
        else {
          const reader = new FileReader();

          reader.onload = ((theFile) => {
            return (event) => {
              this.fileblobs[theFile.name.toLowerCase()] = event.target.result;
              this.checkForDone();
            };
          })(file);
          reader.readAsArrayBuffer(file);
        }
      }, (error) => {
        this.callback({ error: error });
      });
    }
    else if (item.isDirectory) {
      const dirReader = item.createReader();

      dirReader.readEntries((entries) => {
        this.remainingFilesToProcess += entries.length;
        this.checkForDone();

        entries.forEach((entry) => {
          this.traverseFileTree(entry, `${path}${item.name}/`);
        });
      });
    }
  }

  /**
   * Check for being done.
   */
  checkForDone() {
    this.remainingFilesToProcess--;

    if (this.remainingFilesToProcess === 0) {
      this.outputBuffers = [];
      this.bufferMap = new Map();
      this.bufferOffset = 0;

      this.processBuffers()
        .then(() => {
          this.callback({
            file: this.buildOutputFile()
          });
        })
        .catch((error) => {
          this.callback({
            error: error
          });
        });
    }
  }

  /**
   * Process all buffers.
   * @returns {Promise} Result.
   */
  processBuffers() {
    if (!this.gltf) {
      return Promise.reject(
        H5PEditor.t('H5PEditor.ThreeDModel', 'noGLTFFound')
      );
    }

    const pendingBuffers = this.gltf.buffers.map((buffer, bufferIndex) => {
      return this.getDataFromUri(buffer)
        .then((data) => {
          if (data !== undefined) {
            this.outputBuffers.push(data);
          }

          delete buffer.uri;
          buffer.byteLength = data.byteLength;
          this.bufferMap.set(bufferIndex, this.bufferOffset);
          this.bufferOffset += this.getAlignedLength(data.byteLength);
        });
    });

    return Promise.all(pendingBuffers)
      .then(() => {
        let bufferIndex = this.gltf.buffers.length;
        const images = this.gltf.images || [];
        const pendingImages = images.map((image) => {
          return this.getDataFromUri(image).then((data) => {
            if (data === undefined) {
              delete image.uri;
              return;
            }

            const bufferView = {
              buffer: 0,
              byteOffset: this.bufferOffset,
              byteLength: data.byteLength,
            };

            this.bufferMap.set(bufferIndex, this.bufferOffset);
            bufferIndex++;
            this.bufferOffset += this.getAlignedLength(data.byteLength);

            const bufferViewIndex = this.gltf.bufferViews.length;
            this.gltf.bufferViews.push(bufferView);
            this.outputBuffers.push(data);
            image.bufferView = bufferViewIndex;
            image.mimeType = this.getMimeType(image.uri);
            delete image.uri;
          });
        });

        return Promise.all(pendingImages);
      });
  }

  /**
   * Build output file from buffer.
   * @returns {Blob} File blob.
   */
  buildOutputFile() {
    for (let i = 0, a = this.gltf.bufferViews; i < a.length; i++) {
      const bufferView = a[i];
      if (bufferView.byteOffset === undefined) {
        bufferView.byteOffset = 0;
      }
      else {
        bufferView.byteOffset = bufferView.byteOffset +
          this.bufferMap.get(bufferView.buffer);
      }
      bufferView.buffer = 0;
    }

    const binBufferSize = this.bufferOffset;
    this.gltf.buffers = [{
      byteLength: binBufferSize
    }];

    const enc = new TextEncoder();
    const jsonBuffer = enc.encode(JSON.stringify(this.gltf));
    const jsonAlignedLength = this.getAlignedLength(jsonBuffer.length);
    let padding;

    if (jsonAlignedLength !== jsonBuffer.length) {
      padding = jsonAlignedLength - jsonBuffer.length;
    }

    const totalSize =
      FILE_HEADER_SIZE +
      JSON_CHUNK_HEADER_SIZE +
      jsonAlignedLength +
      BIN_CHUNK_HEADER_SIZE +
      binBufferSize;

    const finalBuffer = new ArrayBuffer(totalSize);
    const dataView = new DataView(finalBuffer);

    let bufIndex = 0;
    dataView.setUint32(bufIndex, GLTF_HEADER, true);
    bufIndex += BUFFER_INDEX_INCREMENT;
    dataView.setUint32(bufIndex, GLTF_VERSION, true);
    bufIndex += BUFFER_INDEX_INCREMENT;
    dataView.setUint32(bufIndex, totalSize, true);
    bufIndex += BUFFER_INDEX_INCREMENT;

    // JSON
    dataView.setUint32(bufIndex, jsonAlignedLength, true);
    bufIndex += BUFFER_INDEX_INCREMENT;
    dataView.setUint32(bufIndex, CHUNK_JSON, true);
    bufIndex += BUFFER_INDEX_INCREMENT;

    for (let j = 0; j < jsonBuffer.length; j++) {
      dataView.setUint8(bufIndex, jsonBuffer[j]);
      bufIndex++;
    }

    if (padding !== undefined) {
      for (let j = 0; j < padding; j++) {
        dataView.setUint8(bufIndex, JSON_PADDING);
        bufIndex++;
      }
    }

    // BIN
    dataView.setUint32(bufIndex, binBufferSize, true);
    bufIndex += BUFFER_INDEX_INCREMENT;
    dataView.setUint32(bufIndex, CHUNK_BIN, true);
    bufIndex += BUFFER_INDEX_INCREMENT;

    for (let i = 0; i < this.outputBuffers.length; i++) {
      const bufoffset = bufIndex + this.bufferMap.get(i);
      const buf = new Uint8Array(this.outputBuffers[i]);
      let thisbufindex = bufoffset;
      for (let j = 0; j < buf.byteLength; j++) {
        dataView.setUint8(thisbufindex, buf[j]);
        thisbufindex++;
      }
    }

    return new Blob([finalBuffer], { type: 'model/json-binary' });
  }

  /**
   * Check for base64 encoding.
   * @param {string} uri URI to check for encoding.
   * @returns {boolean} True if URI is base64 encoded.
   */
  isBase64(uri) {
    return uri.startsWith('data:');
  }

  /**
   * Decode URI from base64 encoding.
   * @param {string} uri URI to decode.
   * @returns {Promise} Response.
   */
  decodeBase64(uri) {
    return fetch(uri).then((response) => response.arrayBuffer());
  }

  /**
   * Get data from buffer URI.
   * @param {object} buffer Buffer.
   * @returns {Promise} Result.
   */
  getDataFromUri(buffer) {
    if (buffer.uri === undefined) {
      return Promise.resolve();
    }
    else if (this.isBase64(buffer.uri)) {
      return this.decodeBase64(buffer.uri);
    }
    else {
      const lastSlashIndex = buffer.uri.lastIndexOf('/') + 1;
      const filename = buffer.uri.substring(lastSlashIndex);
      return Promise.resolve(this.fileblobs[filename.toLowerCase()]);
    }
  }

  /**
   * Get aligned value.
   * @param {number} value Value.
   * @returns {number} Aligned value.
   */
  getAlignedLength(value) {
    if (value === 0) {
      return value;
    }

    const alignValue = 4;
    const multiple = value % alignValue;
    return (multiple === 0) ? value : value + (alignValue - multiple);
  }

  /**
   * Get MIME type.
   * @param {string} filename File name.
   * @returns {string} MIME type.
   */
  getMimeType(filename) {
    const fileExtension = filename.toLowerCase().split('.').pop();

    for (const mimeType in this.gltfMimeTypes) {
      if (this.gltfMimeTypes[mimeType].includes(fileExtension)) {
        return mimeType;
      }
    }

    return 'application/octet-stream';
  }
}
export default threeDModelGLTF2GLB;
