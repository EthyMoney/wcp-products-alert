/*
This is a program to monitor West Coast Products for new product listings and generation a notification when new products are found.
*/

// URL: https://wcproducts.com/collections/new-products

// CSS selector to container of product elements: .tt-product-listing
// - this element contains multiple DIV (div.col-6:nth-child(1)) elements, each containing these items. The index of the div.col-6:nth-child(1) elements is the index of the product in the list.
//  - product name: div.col-6:nth-child(1) > div:nth-child(1) > div:nth-child(2) > h2:nth-child(1) > a:nth-child(1)
//  - product image (the href): div.col-6:nth-child(1) > div:nth-child(1) > div:nth-child(1) > a:nth-child(1)
//  - product price: div.col-6:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > span:nth-child(1) > span:nth-child(1)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const axios = require('axios');

const URL = 'https://wcproducts.com/collections/new-products';
const CACHE_FILE = path.join(__dirname, 'product_cache.json');
const IMAGES_DIR = path.join(__dirname, 'images');
const config = require('./config.json');

// Ensure the images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR);
}

async function fetchProducts() {
  try {
    const response = await fetch(URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${URL}: ${response.statusText}`);
    }
    const text = await response.text();
    const dom = new JSDOM(text);
    const document = dom.window.document;

    const products = [];
    const productElements = document.querySelectorAll('.tt-product-listing .col-6');
    const totalProducts = productElements.length;
    const cachedProducts = loadCache();

    for (let i = 0; i < totalProducts; i++) {
      const element = productElements[i];
      const name = element.querySelector('div:nth-child(1) > div:nth-child(2) > h2:nth-child(1) > a:nth-child(1)').textContent.trim();
      const productPage = 'https://wcproducts.com' + element.querySelector('div:nth-child(1) > div:nth-child(2) > h2:nth-child(1) > a:nth-child(1)').href;
      let imageUrl = 'https:' + element.querySelector('div:nth-child(1) > div:nth-child(1) > a:nth-child(1) > span:nth-child(1) > img:nth-child(1)').getAttribute('data-mainimage');
      const price = element.querySelector('div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > span:nth-child(1) > span:nth-child(1)').textContent.trim();

      // Modify the image URL to match the desired format and remove the query parameter
      imageUrl = imageUrl.replace('respimgsize', '145x').split('?')[0];

      // Check if the product is already cached
      const cachedProduct = cachedProducts.find(p => p.name === name);

      let imageId;
      if (!cachedProduct || !cachedProduct.imageId) {
        // Extract the image extension from the URL
        const imageExtension = path.extname(imageUrl);

        imageId = crypto.randomBytes(16).toString('hex');
        const imagePath = path.join(IMAGES_DIR, `${imageId}${imageExtension}`);

        // Download and save the image
        const imageResponse = await fetch(imageUrl);
        const imageArrayBuffer = await imageResponse.arrayBuffer();
        fs.writeFileSync(imagePath, Buffer.from(imageArrayBuffer));
      } else {
        imageId = cachedProduct.imageId;
      }

      products.push({ name, productPage, imageId, imageUrl, price });

      // Display progress
      process.stdout.write(`Checked ${i + 1} of ${totalProducts} products\r`);
    }

    // Clear the line after completion
    process.stdout.write('\n');

    return products;
  } catch (error) {
    console.error('Error fetching products:', error);
    return [];
  }
}

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(data);
  }
  return [];
}

function saveCache(products) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(products, null, 2));
}

function notifyNewProduct(product) {
  console.log('New product detected:', product);
  sendToSlack(product.name, product.price, product.productPage, product.imageUrl);
}

async function checkForNewProducts() {
  console.log('\nChecking for new products...');
  const currentProducts = await fetchProducts();
  const cachedProducts = loadCache();

  const newProducts = currentProducts.filter(product =>
    !cachedProducts.some(cachedProduct => cachedProduct.name === product.name)
  );

  // only send if the cache was not empty (don't want to flood with evert product on the first ever run)
  if (cachedProducts.length > 0) {
    newProducts.forEach(product => {
      product.cachedTime = new Date().toISOString();
      notifyNewProduct(product);
    });
  }
  else {
    console.log('Cache is empty, not sending notifications on first run to avoid spamming. Check as normal going forward.');
  }

  console.log(`Total products on the page: ${currentProducts.length}`);
  console.log(`Total products in the cache: ${cachedProducts.length}`);
  console.log(`New products detected: ${newProducts.length}`);

  if (newProducts.length > 0) {
    saveCache([...cachedProducts, ...newProducts]);
  }
}

async function sendToSlack(newProductName, newProductPrice, newProductLink, newProductImageUrl) {
  if (config.slack?.enableBot === false) {
    console.log('Slack bot is disabled in the config, not sending notification.');
    return;
  }
  console.log('Sending new product notification to Slack...');
  const url = 'https://slack.com/api/chat.postMessage';
  const authorizationHeader = { headers: { authorization: `Bearer ${config.slack.token}` } };

  const message = {
    channel: config.slack.channelName,
    username: 'West Coast Products Alerts',
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚨 *New product detected!* 🚨`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Product:*\n<${newProductLink}|${newProductName}>`
          },
          {
            type: 'mrkdwn',
            text: `*Price:*\n${newProductPrice}`
          }
        ],
        accessory: {
          type: 'image',
          image_url: newProductImageUrl,
          alt_text: newProductName
        }
      }
    ]
  };

  await axios.post(url, message, authorizationHeader)
    .then(() => {
      console.log(`Successfully sent notification to Slack!`);
    })
    .catch(function (reject) {
      console.error(`Error sending notification to Slack with promise rejection: ${reject}`);
    });
}

// ================================
//             Startup
// ================================

// if products cache is empty, clean out the images folder so there's nothing leftover in there and we start fresh
if (loadCache().length === 0) {
  fs.readdir(IMAGES_DIR, (err, files) => {
    if (err) throw err;
    for (const file of files) {
      fs.unlink(path.join(IMAGES_DIR, file), err => {
        if (err) throw err;
      });
    }
  });
}
setInterval(checkForNewProducts, 180000); // Check every 3 minutes
checkForNewProducts(); // Initial check

// send test message to slack - uncomment to use
//sendToSlack('TEST - TalonFX stuff', '$100', 'https://wcproducts.com/collections/new-products/products/talonfxs-motor-controller-and-motors', 'https://wcproducts.com/cdn/shop/files/TalonFXS_145x.png');
