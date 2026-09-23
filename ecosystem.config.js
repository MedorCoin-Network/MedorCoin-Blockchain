module.exports = {
  apps: [
    { 
      name: "redis-6379", 
      script: "redis-server", 
      args: "--port 6379 --cluster-enabled yes --cluster-config-file nodes-6379.conf --daemonize no" 
    },
    { 
      name: "redis-6380", 
      script: "redis-server", 
      args: "--port 6380 --cluster-enabled yes --cluster-config-file nodes-6380.conf --daemonize no" 
    },
    { 
      name: "redis-6381", 
      script: "redis-server", 
      args: "--port 6381 --cluster-enabled yes --cluster-config-file nodes-6381.conf --daemonize no" 
    },
    { 
      name: "medor-engine", 
      script: "npm start", 
      delay: 5000 
    }
  ]
};
